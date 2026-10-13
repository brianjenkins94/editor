/**
 * ENFORCE — the single capability DECISION ENDPOINT (ext host). Every runtime interceptor (the service-worker
 * net gate, the almostnode fs/exec shim hook) is THIN and full-round-trips here; no policy, grant store, or
 * prompt lives in an interceptor. This is the one place the shared brain runs:
 *
 *   classify(raw call) → silo scope → broker.gate(redline → grant store → decider) → allow | deny
 *
 * It reuses the portable core published in @brianjenkins94/util/silo/enforce: `gate`/`CapabilityDenied`
 * (the fixed order), `redline` (BERNARD catastrophic scopes), and the intercept helpers (CAP_FS + scope
 * builders) as the single classification source. The decider is a VS Code popup today (Allow / Allow always /
 * Deny); an external program or AI can replace it later behind the same seam. All `.silo/` I/O — the base+override
 * policy merge, the observed-capability rollup, the run firehose — lives in silo-store.ts.
 */
import type { BrokerOptions, CapabilityRequest, Verdict } from "@brianjenkins94/util/silo/enforce/broker";
import type { Effect } from "@brianjenkins94/util/silo/evidence";
import { FS_ASYNC, FS_SYNC } from "@brianjenkins94/almostnode/fs-capabilities";
import { createRpcClient } from "@brianjenkins94/hub";
import { CapabilityDenied, gate } from "@brianjenkins94/util/silo/enforce/broker";
import { CAP_FS, evalScope, execScope, fsScope, hostOf, netScope } from "@brianjenkins94/util/silo/enforce/intercept";
import { effectiveDisposition, isDangerous } from "@brianjenkins94/util/silo/policy";
import { loadEffectivePolicy, persistOverride, recordObservation } from "../../../shared/capabilities/silo-store";
import { bridgeHub } from "../hub";
import { coalesce } from "./coalesce";

/**
 * The RAW call an interceptor sends — deliberately un-classified so the interceptors stay dumb and decoupled
 * (almostnode never imports the policy core, the SW never builds a scope). Classification happens HERE.
 *   • net: `{ kind: "net", args: [input, init] }` — host derived from the request.
 *   • fs:  `{ kind: "fs", method, args: [path, …] }` — op derived from the method, path from arg 0.
 *   • exec:`{ kind: "exec", args: [command, …] }`.
 *   • eval:`{ kind: "eval", resource }` — the codegen kind.
 */
export interface CapabilityCall {
	"kind": "net" | "fs" | "exec" | "eval" | "net.ws" | "net.webrtc";
	"method"?: string;
	"op"?: "read" | "write";
	"resource"?: string;
	"args"?: readonly unknown[];
	/** The run this call belongs to, when known (a preview's, by its port): counted among that run's effects, which its
	 *  envelope in the run ledger lists (run-effects.ts's recordEffect). */
	"runId"?: string;
	/** The preview port a shell-forwarded call (the WS/WebRTC shim) originates from — the ext host resolves it to
	 *  the run that owns the port (mirroring the SW's runId for net), since the shim can't know the runId itself. */
	"port"?: number;
	/** The preview window it came from, when the caller knows (the WS/WebRTC shim's requests arrive from one): the
	 *  prompt shows there. The service worker's net gate knows only the port — every window of a server has its address. */
	"window"?: string;
	/** The package whose code made it (a debug run's, beyond its baseline: runtime-fs.ts), by name@version — its run
	 *  counts it, as that package's, so it isn't counted here too. */
	"package"?: string;
}

/** How a call was decided (util/silo's Effect `decided`): by the policy, or at the call — the person's answer. */
export type Decided = NonNullable<Effect["decided"]>;

/** Turn a raw interceptor call into the canonical silo request (scope string + context), or undefined if it
 *  isn't a gated capability (e.g. an fs method neither almostnode nor CAP_FS gates). */
function classify(call: CapabilityCall): CapabilityRequest | undefined {
	const arg0 = call.args?.[0];

	if (call.kind === "net") {
		const host = hostOf(arg0);

		return { "kind": "net", "scope": netScope(host), "resource": host };
	}

	// WebSocket / WebRTC — captured in the preview realm (the SW can't see them). Gate by endpoint host, one
	// capability axis per protocol so a `net` allow doesn't silently cover a socket.
	if (call.kind === "net.ws" || call.kind === "net.webrtc") {
		const resource = typeof arg0 === "string" ? arg0 : call.resource ?? "";

		return { "kind": call.kind, "scope": `${call.kind}:${endpointOf(resource)}`, "resource": resource } as CapabilityRequest;
	}

	if (call.kind === "fs") {
		const op = call.op ?? (call.method !== undefined ? FS_SYNC[call.method] ?? FS_ASYNC[call.method] ?? CAP_FS[call.method] : undefined);

		if (op === undefined) {
			return undefined; // not a gated fs method
		}

		const path = typeof arg0 === "string" ? arg0 : call.resource ?? "";

		return { "kind": "fs", "op": op, "scope": fsScope(op, path), "resource": path };
	}

	if (call.kind === "exec") {
		const bin = typeof arg0 === "string" ? arg0 : call.resource ?? "";

		return { "kind": "exec", "scope": execScope(bin), "resource": bin };
	}

	const kind = call.resource ?? "eval";

	return { "kind": "eval", "scope": evalScope(kind), "resource": kind };
}

/** The silo capability axis for a request: `fs:read`/`fs:write` carry the op; net/exec/eval/net.ws/net.webrtc are
 *  the kind. */
function capabilityOf(request: CapabilityRequest): string {
	return request.kind === "fs" ? `fs:${request.op ?? "read"}` : request.kind;
}

/** Each run's answers at the call: the scopes allowed once — for the rest of that run, never the next — and those
 *  refused, not asked again in it. Persisted decisions live in the policy (consulted by the decider), not here. */
const runAnswers = new Map<string, { "allowed": Set<string>; "refused": Set<string> }>();
/** How many runs' answers are kept: a run asks again only while it runs, and runs end. */
const KEEP_RUNS = 64;

/** `runId`'s answers so far (undefined with no run: a call that isn't a run's is asked each time). */
function answersOf(runId: string | undefined): { "allowed": Set<string>; "refused": Set<string> } | undefined {
	if (runId === undefined) {
		return undefined;
	}

	let answers = runAnswers.get(runId);

	if (answers === undefined) {
		answers = { "allowed": new Set(), "refused": new Set() };
		runAnswers.set(runId, answers);

		for (const old of [...runAnswers.keys()].slice(0, Math.max(0, runAnswers.size - KEEP_RUNS))) {
			runAnswers.delete(old);
		}
	}

	return answers;
}

/** Where a prompt shows: the request's preview window and port, as far as they're known. */
function windowOf(request: object): { "port"?: number; "window"?: string } {
	const { port, window } = request as { "port"?: number; "window"?: string };

	return { ...typeof port === "number" ? { "port": port } : {}, ...typeof window === "string" ? { "window": window } : {} };
}

const shellRpc = createRpcClient(bridgeHub);

/** The TOFU prompt: OUR WebAwesome overlay INSIDE the preview window (shell-preview.ts), reached over the hub —
 *  never a VS Code notification. Returns the user's choice, or undefined if the shell can't be reached at all
 *  (then we fail CLOSED: if we can't ask, we don't allow — an unreachable shell is a bigger problem anyway). */
async function promptViaShell(request: { "kind": string; "scope": string; "resource": string; "dangerous"?: boolean; "redline"?: boolean; "port"?: number; "window"?: string }): Promise<string | undefined> {
	try {
		const reply = await shellRpc.request("capability.prompt", request, { "timeoutMs": 300000 });

		return typeof reply === "string" ? reply : undefined;
	} catch {
		return undefined;
	}
}

/** The decider: consult the effective policy FIRST — my `policy/<user>.json` overrides layered over the base
 *  `policy.json` contract — and allow / deny with NO prompt (so pre-approved scopes and default-allow patterns
 *  like fs:read under the workspace never nag). For an undecided (review) capability, raise the WebAwesome prompt
 *  overlay in the preview window. "Allow always" writes an allow rule to MY override file (never the shared
 *  contract — that's your "don't show again"); "Allow once" is session-only (the broker adds it to the session
 *  store). Swappable for an external/AI decider behind this same seam. */
async function policyDecider(request: CapabilityRequest): Promise<Verdict & { "decided": Decided }> {
	const capability = capabilityOf(request);
	const resource = request.resource ?? "";
	const effective = effectiveDisposition(await loadEffectivePolicy(), capability, resource, isDangerous(capability));

	if (effective === "allow") {
		return { "behavior": "allow", "decided": "policy" };
	}

	if (effective === "deny") {
		return { "behavior": "deny", "message": "denied by .silo policy", "decided": "policy" };
	}

	// Skipped (util/silo's `skip`): not made. Here there's no stand-in to answer it in its place, as a debug run has — so,
	// as an enforcer without one, the gate refuses it.
	if (effective === "skip") {
		return { "behavior": "deny", "message": "skipped by .silo policy", "decided": "policy" };
	}

	let choice = await promptViaShell({ "kind": request.kind, "scope": request.scope, "resource": resource, "dangerous": isDangerous(capability), ...windowOf(request) });

	// Rule…: the rule is made in the Rules view (rules-view.ts `rules.make`), and the call waits on it; cancelled, the
	// question comes back.
	while (choice === "rule") {
		let made: unknown;

		try {
			made = await shellRpc.request("rules.make", { "capability": capability, "resource": resource }, { "timeoutMs": 300000 });
		} catch {
			made = null;
		}

		// (a rule made at the call is the person's answer, in their policy now: as Allow always, or a refusal)
		if (made === "allow" || made === "deny") {
			return made === "allow" ? { "behavior": "allow", "decided": "always" } : { "behavior": "deny", "message": "denied by your rule", "decided": "refused" };
		}

		choice = await promptViaShell({ "kind": request.kind, "scope": request.scope, "resource": resource, "dangerous": isDangerous(capability), ...windowOf(request) });
	}

	if (choice === "allow-always") {
		await persistOverride(capability, resource, "allow");

		return { "behavior": "allow", "decided": "always" };
	}

	if (choice === "allow-once") {
		return { "behavior": "allow", "decided": "once" };
	}

	return { "behavior": "deny", "message": choice === "deny" ? "denied" : "no decision", "decided": "refused" };
}

/** BERNARD break-glass for redline scopes — the preview overlay's redline variant (a deliberate one-time
 *  "Authorize once"); never persisted. Fail closed if the shell can't be reached. */
async function breakGlass(request: CapabilityRequest): Promise<boolean> {
	return (await promptViaShell({ "kind": request.kind, "scope": request.scope, "resource": request.resource ?? "", "redline": true, ...windowOf(request) })) === "authorize";
}

// The same question from the same window, asked while it's still waiting (six peer connections opened at once), gets
// one prompt and one answer — "Allow always" written once. (Redline break-glass stays one deliberate answer per call.)
const decide = coalesce((request: CapabilityRequest) => JSON.stringify([capabilityOf(request), request.scope, request.resource ?? "", windowOf(request)]), policyDecider);

/**
 * Decide one raw capability call: whether it may be made, and how that was decided — by the policy, or at the call, the
 * person's answer (an exception to the policy, recorded among its run's effects). This is the endpoint every interceptor
 * round-trips to; a non-capability call (unclassifiable) is allowed (nothing to gate). Within a run, a scope allowed
 * once stays allowed, and one refused stays refused, until it ends; the next run asks again.
 */
export async function decideCapabilityAs(call: CapabilityCall): Promise<{ "allow": boolean; "decided": Decided }> {
	const request = classify(call);

	if (request === undefined) {
		return { "allow": true, "decided": "policy" };
	}

	// Carry where it came from onto the request so the decider can route the TOFU overlay there: the preview window
	// when known (the WS/WebRTC shim), else its port (the SW net gate — any window of that server).
	if (typeof call.port === "number") {
		(request as { "port"?: number }).port = call.port;
	}

	if (typeof call.window === "string") {
		(request as { "window"?: string }).window = call.window;
	}

	const answers = answersOf(call.runId);
	// (a package's call is counted by its run, as that package's: its debugger's)
	const counted = call.package === undefined ? call.runId : undefined;
	// (an object: the broker's callbacks below set it, which a `let` narrowed to its first value wouldn't show)
	const how: { "decided": Decided } = { "decided": "policy" };

	if (answers?.refused.has(request.scope) === true) {
		recordObservation(request, "deny", counted, "refused");

		return { "allow": false, "decided": "refused" };
	}

	const options: BrokerOptions = {
		"store": {
			"has": (scope) => {
				const allowed = answers?.allowed.has(scope) === true;

				if (allowed) {
					how.decided = "once";
				}

				return allowed;
			},
			// (the broker grants every allow; only an answer of "once" is this run's to remember — the policy's are the policy's)
			"grant": (scope) => {
				if (how.decided === "once") {
					answers?.allowed.add(scope);
				}
			}
		},
		"decide": async (asked) => {
			const verdict = await decide(asked);

			how.decided = verdict.decided;

			return verdict;
		},
		"breakGlass": async (asked) => {
			const authorized = await breakGlass(asked);

			how.decided = authorized ? "once" : "refused";

			return authorized;
		}
	};

	try {
		await gate(request, options);
		recordObservation(request, "allow", counted, how.decided); // fired ⇒ observed surface + this run's record

		return { "allow": true, "decided": how.decided };
	} catch (error) {
		if (error instanceof CapabilityDenied) {
			if (how.decided === "refused") {
				answers?.refused.add(request.scope);
			}

			recordObservation(request, "deny", counted, how.decided); // attempt-but-blocked: recorded, not in the surface

			return { "allow": false, "decided": how.decided };
		}

		throw error;
	}
}

/** Decide one raw capability call: `true` to allow, `false` to deny (decideCapabilityAs, without how). */
export async function decideCapability(call: CapabilityCall): Promise<boolean> {
	return (await decideCapabilityAs(call)).allow;
}

/** The network endpoint of a WS/WebRTC resource: `hostOf` covers ws(s):// (a special scheme with a real host);
 *  stun:/turn: are non-special (URL.host is empty → "*"), so parse `scheme:host:port` by hand. */
function endpointOf(resource: string): string {
	const host = hostOf(resource);

	if (host !== "*") {
		return host;
	}

	const match = /^[a-z][a-z0-9+.-]*:([^?#]+)/iu.exec(resource);

	return match !== null ? match[1] : resource;
}

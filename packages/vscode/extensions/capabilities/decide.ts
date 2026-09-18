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
import type { BrokerOptions, CapabilityRequest, GrantStore, Verdict } from "@brianjenkins94/util/silo/enforce/broker";
import * as vscode from "vscode";
import { CapabilityDenied, gate } from "@brianjenkins94/util/silo/enforce/broker";
import { CAP_FS, evalScope, execScope, fsScope, hostOf, netScope } from "@brianjenkins94/util/silo/enforce/intercept";
import { isDangerous } from "@brianjenkins94/util/silo/policy";
import { effectiveDisposition } from "./policy-core";
import { loadEffectivePolicy, persistOverride, recordObservation } from "./silo-store";

/**
 * The RAW call an interceptor sends — deliberately un-classified so the interceptors stay dumb and decoupled
 * (almostnode never imports the policy core, the SW never builds a scope). Classification happens HERE.
 *   • net: `{ kind: "net", args: [input, init] }` — host derived from the request.
 *   • fs:  `{ kind: "fs", method, args: [path, …] }` — op derived from the method, path from arg 0.
 *   • exec:`{ kind: "exec", args: [command, …] }`.
 *   • eval:`{ kind: "eval", resource }` — the codegen kind.
 */
export interface CapabilityCall {
	"kind": "net" | "fs" | "exec" | "eval";
	"method"?: string;
	"op"?: "read" | "write";
	"resource"?: string;
	"args"?: readonly unknown[];
	/** The almostnode run this call belongs to, when known (the fs shim threads it). Lets the observation attribute
	 *  to a run so `<user>.runs.jsonl` gets one run-grain record instead of a line per call. Absent for a preview
	 *  app's own fetch (which belongs to no single run) — those stay call-grain. */
	"runId"?: string;
}

/** Turn a raw interceptor call into the canonical silo request (scope string + context), or undefined if it
 *  isn't a gated capability (e.g. an fs method not in CAP_FS). */
function classify(call: CapabilityCall): CapabilityRequest | undefined {
	const arg0 = call.args?.[0];

	if (call.kind === "net") {
		const host = hostOf(arg0);

		return { "kind": "net", "scope": netScope(host), "resource": host };
	}

	if (call.kind === "fs") {
		const op = call.op ?? (call.method !== undefined ? CAP_FS[call.method] : undefined);

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

/** The silo capability axis for a request: `fs:read`/`fs:write` carry the op; net/exec/eval are the kind. */
function capabilityOf(request: CapabilityRequest): string {
	return request.kind === "fs" ? `fs:${request.op ?? "read"}` : request.kind;
}

/** Session-only store — "Allow once" lives here (a fast-path short-circuit in broker.gate); persisted decisions
 *  live in the policy file (consulted by the decider), so the store itself needs no disk. */
function createSessionStore(): GrantStore {
	const session = new Set<string>();

	return {
		"has": (scope) => session.has(scope),
		"grant": (scope) => { session.add(scope); }
	};
}

/** The decider: consult the effective policy FIRST — my `<user>.policy.json` overrides layered over the base
 *  `policy.json` contract — and allow / deny with NO prompt (so pre-approved scopes and default-allow patterns
 *  like fs:read under the workspace never nag). For an undecided (review) capability, show the VS Code popup.
 *  "Allow always" writes an allow rule to MY override file (never the shared contract — that's your "don't show
 *  again"); "Allow once" is session-only (the broker adds it to the session store). Swappable for an external/AI
 *  decider behind this same seam. */
async function policyDecider(request: CapabilityRequest): Promise<Verdict> {
	const capability = capabilityOf(request);
	const resource = request.resource ?? "";
	const effective = effectiveDisposition(await loadEffectivePolicy(), capability, resource, isDangerous(capability));

	if (effective === "allow") {
		return { "behavior": "allow" };
	}

	if (effective === "deny") {
		return { "behavior": "deny", "message": "denied by .silo policy" };
	}

	const pick = await vscode.window.showInformationMessage(
		`Allow ${request.kind} — ${request.scope}?`,
		{ "modal": false },
		"Allow once",
		"Allow always",
		"Deny"
	);

	if (pick === "Allow always") {
		await persistOverride(capability, resource, "allow");

		return { "behavior": "allow" };
	}

	if (pick === "Allow once") {
		return { "behavior": "allow" };
	}

	return { "behavior": "deny", "message": pick === "Deny" ? "denied" : "dismissed" };
}

/** BERNARD break-glass for redline scopes — a MODAL the user must actively confirm; never persisted. */
async function breakGlass(request: CapabilityRequest): Promise<boolean> {
	const pick = await vscode.window.showWarningMessage(
		`⛔ Redline capability: ${request.scope}\n\nThis is a catastrophic scope that cannot be routinely allowed. Authorize this ONE time?`,
		{ "modal": true },
		"Authorize once"
	);

	return pick === "Authorize once";
}

const store = createSessionStore();
const options: BrokerOptions = { "store": store, "decide": policyDecider, "breakGlass": breakGlass };

/**
 * Decide one raw capability call. Resolves `true` to allow, `false` to deny. This is the endpoint every
 * interceptor round-trips to; a non-capability call (unclassifiable) is allowed (nothing to gate).
 */
export async function decideCapability(call: CapabilityCall): Promise<boolean> {
	const request = classify(call);

	if (request === undefined) {
		return true;
	}

	try {
		await gate(request, options);
		recordObservation(request, "allow", call.runId); // fired ⇒ observed surface + this run's record

		return true;
	} catch (error) {
		if (error instanceof CapabilityDenied) {
			recordObservation(request, "deny", call.runId); // attempt-but-blocked: recorded, not in the surface

			return false;
		}

		throw error;
	}
}

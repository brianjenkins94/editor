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
 * Deny); an external program or AI can replace it later behind the same seam. Grants persist under `.silo/`.
 */
import type { BrokerOptions, CapabilityRequest, GrantStore, Verdict } from "@brianjenkins94/util/silo/enforce/broker";
import * as vscode from "vscode";
import { CapabilityDenied, gate } from "@brianjenkins94/util/silo/enforce/broker";
import { CAP_FS, evalScope, execScope, fsScope, hostOf, netScope } from "@brianjenkins94/util/silo/enforce/intercept";

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

/** The `.silo/grants.json` under the (first) workspace root — the TOFU-persisted approved scopes. */
function grantsUri(): vscode.Uri | undefined {
	const folder = vscode.workspace.workspaceFolders?.[0];

	return folder === undefined ? undefined : vscode.Uri.joinPath(folder.uri, ".silo", "grants.json");
}

/** A grant store over `.silo/grants.json` (silo registry model, simplified to a flat approved-scope list):
 *  session grants live in memory; "Allow always" also persists. Loaded once, lazily. */
function createGrantStore(): GrantStore {
	const session = new Set<string>();
	let persisted: Set<string> | undefined;

	const load = async (): Promise<Set<string>> => {
		if (persisted !== undefined) {
			return persisted;
		}

		persisted = new Set();

		const uri = grantsUri();

		if (uri !== undefined) {
			try {
				const parsed = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))) as { "approved"?: string[] };

				for (const scope of parsed.approved ?? []) {
					persisted.add(scope);
				}
			} catch { /* absent or malformed → empty */ }
		}

		return persisted;
	};

	const save = async (): Promise<void> => {
		const uri = grantsUri();

		if (uri === undefined || persisted === undefined) {
			return;
		}

		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, ".."));
		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify({ "approved": [...persisted].sort() }, null, "\t") + "\n"));
	};

	return {
		"has": (scope) => session.has(scope) || (persisted?.has(scope) ?? false),
		"grant": async (scope, persist) => {
			session.add(scope);

			if (persist === true) {
				(await load()).add(scope);
				await save();
			}
		}
	};
}

/** The VS Code popup decider — "Allow / Allow always / Deny". "Allow always" persists (your "don't show
 *  again"). Dismissing (Escape) is a decline → deny. Swappable for an external/AI decider behind this seam. */
async function popupDecider(request: CapabilityRequest): Promise<Verdict> {
	const pick = await vscode.window.showInformationMessage(
		`Allow ${request.kind} — ${request.scope}?`,
		{ "modal": false },
		"Allow once",
		"Allow always",
		"Deny"
	);

	if (pick === "Allow once") {
		return { "behavior": "allow" };
	}

	if (pick === "Allow always") {
		return { "behavior": "allow", "persist": true };
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

const store = createGrantStore();
const options: BrokerOptions = { "store": store, "decide": popupDecider, "breakGlass": breakGlass };

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

		return true;
	} catch (error) {
		if (error instanceof CapabilityDenied) {
			return false;
		}

		throw error;
	}
}

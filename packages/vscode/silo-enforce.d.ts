/**
 * Ambient types for `@brianjenkins94/util/silo/enforce/*` — the capability enforcement core.
 *
 * These modules are hand-authored `.mjs` (raw ESM, so a `--import` preload / injected bundle loads them
 * with no build step), and util-publish ships the `.mjs` WITHOUT declarations (it only generates `.d.ts`
 * from `.ts` sources). So the editor carries their types here instead of the tarball — see the header of
 * each module in the `lib` repo (util/silo/enforce/) for behavior.
 */

declare module "@brianjenkins94/util/silo/enforce/decide" {
	/** Is this scope on BERNARD's catastrophic redline list? (conservative; over-flag = safe). */
	export function redline(scope: string): boolean;
	/** The JUDICIAL decider: null (unset/"ask" → caller's fallback) or a verdict. Fails closed. */
	export function judicial(request: unknown): { "behavior": "allow" | "deny"; "scope"?: string; "message"?: string } | null;
}

declare module "@brianjenkins94/util/silo/enforce/broker" {
	export type Behavior = "allow" | "deny";

	/** A decider's verdict — mirrors silo's JUDICIAL contract / the Agent SDK PermissionResult / an MCP
	 *  elicitation response. `scope` may narrow the grant; `persist` requests TOFU persistence. */
	export interface Verdict {
		"behavior": Behavior;
		"scope"?: string;
		"message"?: string;
		"persist"?: boolean;
	}

	/** A capability request at a boundary. `scope` is the canonical silo scope string
	 *  (`net:<host>`, `fs:read:<path>`, `fs:write:<path>`, `exec:<bin>`, `eval:<kind>`). */
	export interface CapabilityRequest {
		"kind": "net" | "fs" | "exec" | "eval";
		"scope": string;
		"op"?: "read" | "write";
		"resource"?: string;
		[key: string]: unknown;
	}

	/** The pluggable decision source — a VS Code allow/deny popup today; an external program or AI later.
	 *  Returns a verdict, or null to abstain (⇒ fail closed). Same request/verdict shape as MCP elicitation. */
	export type Decider = (request: CapabilityRequest) => Promise<Verdict | null> | Verdict | null;

	/** BERNARD break-glass for redline scopes — human-only, never persisted. Absent/false fails CLOSED. */
	export type BreakGlass = (request: CapabilityRequest) => Promise<boolean> | boolean;

	/** TOFU grant store (silo registry model). `has` = already approved (session or persisted). */
	export interface GrantStore {
		"has": (scope: string) => boolean;
		"grant": (scope: string, persist?: boolean) => void | Promise<void>;
	}

	export interface BrokerOptions {
		"store": GrantStore;
		"decide": Decider;
		"breakGlass"?: BreakGlass;
	}

	export class CapabilityDenied extends Error {
		public readonly scope: string;
		constructor(scope: string, reason: string);
	}

	/** Decide one request (BERNARD → grant store → decider → deny). Resolves on allow; throws on deny. */
	export function gate(request: CapabilityRequest, options: BrokerOptions): Promise<void>;
}

declare module "@brianjenkins94/util/silo/enforce/intercept" {
	/** fs method name → the op it performs. */
	export const CAP_FS: Record<string, "read" | "write">;
	/** child_process method names that spawn a process. */
	export const CAP_EXEC: Set<string>;

	export function fsScope(op: "read" | "write", path: string): string;
	export function netScope(host: string): string;
	export function execScope(bin: string): string;
	export function evalScope(kind: string): string;
	/** Host (with port) from a fetch input, or `*` when indeterminate (a redline). */
	export function hostOf(input: unknown): string;
}

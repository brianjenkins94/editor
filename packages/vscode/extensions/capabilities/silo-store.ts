/**
 * `.silo/` store — the on-disk capability layout the editor owns as silo's FIRST-CLASS harness (no silo CLI
 * exists; this is the reference writer). Two independent axes, and the layout keeps each axis's base/derived
 * halves apart because the GAP between them is the security signal:
 *
 *   .silo/
 *     policy.json               DECISIONS · base    — the contract, human-authored (we only READ it)
 *     <user>.policy.json        DECISIONS · mine    — overrides; "Allow always"/"Deny always" write HERE
 *     capabilities.json         FACTS · static      — what analysis says code CAN do (written by the panel side)
 *     <user>.capabilities.json  FACTS · observed    — what I actually saw FIRE (rollup, day-coarsened)
 *     <user>.runs.jsonl         FACTS · observed    — the raw observation firehose (the exposure ledger)
 *     .gitignore                silo-managed        — ignores *.runs.jsonl
 *
 * Why never merge the axes:
 *   • base vs override — silo must never rewrite the reviewable CONTRACT; a person's grants land in their own
 *     git-user-scoped file, so overrides commit conflict-free (everyone writes only their file).
 *   • static vs observed — a scope OBSERVED with no matching STATIC entry is the alarm (dynamic eval, obfuscation,
 *     a supply-chain payload that reads clean and runs dirty). Merged, that signal is gone.
 *
 * Timestamps land per axis, each answering a different question: `added` (when I authorized) on the override
 * rule; firstObserved/lastObserved (when it fired) on the observed rollup; the fine-grained event stream in
 * <user>.runs.jsonl. "lastAllowed" and "was I exposed to compromised dep X in window W" are QUERIES over the
 * observed side, never stored decision state.
 *
 * MONOREPO-READY: siloRoot() is the one place the responsible `.silo` is resolved. Today it's the single
 * workspace root; later it resolves the nearest `.silo` walking up from a run's entry, so a monorepo can carry a
 * root `.silo` plus per-package ones without any schema change. No caller assumes a single root.
 */
import type { CapabilityRequest } from "@brianjenkins94/util/silo/enforce/broker";
import type { Disposition, Policy } from "./policy-core";
import * as vscode from "vscode";
import { EMPTY_POLICY, parsePolicy, withRule } from "./policy-core";

// ── paths ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The responsible `.silo` directory. MONOREPO SEAM: resolve the nearest one walking up from a run's entry here
 *  later; for now the single workspace root. Returns undefined with no workspace (nothing to persist). */
function siloRoot(): vscode.Uri | undefined {
	const folder = vscode.workspace.workspaceFolders?.[0];

	return folder === undefined ? undefined : vscode.Uri.joinPath(folder.uri, ".silo");
}

// ── file I/O (workspace.fs; tolerant of absence) ─────────────────────────────────────────────────────────────

async function readText(uri: vscode.Uri): Promise<string | undefined> {
	try {
		return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
	} catch {
		return undefined; // absent / unreadable
	}
}

async function writeText(uri: vscode.Uri, text: string): Promise<void> {
	await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, ".."));
	await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
}

// ── current git user (the <user> in every per-user file) ─────────────────────────────────────────────────────

let userCache: string | undefined;

/** The current git user's slug — the `<user>` prefix. Derived from `.git/config` user.email local-part (so
 *  `brianjenkins94@gmail.com` → `brianjenkins94`), falling back to a slugified user.name, then "local". Cached
 *  for the session (identity doesn't change mid-session). */
export async function currentUser(): Promise<string> {
	if (userCache !== undefined) {
		return userCache;
	}

	userCache = "local";

	const folder = vscode.workspace.workspaceFolders?.[0];

	if (folder !== undefined) {
		const config = await readText(vscode.Uri.joinPath(folder.uri, ".git", "config"));
		const slug = config === undefined ? undefined : userFromGitConfig(config);

		if (slug !== undefined) {
			userCache = slug;
		}
	}

	return userCache;
}

/** Pull a slug out of a git config's `[user]` section — email local-part preferred, else name. */
function userFromGitConfig(config: string): string | undefined {
	let inUser = false;
	let email: string | undefined;
	let name: string | undefined;

	for (const raw of config.split(/\r?\n/)) {
		const line = raw.trim();

		if (line.startsWith("[")) {
			inUser = /^\[user(\s|\]|")/.test(line); // `[user]` or `[user "x"]`, not `[remote …]`

			continue;
		}

		if (!inUser) {
			continue;
		}

		const eq = line.indexOf("=");

		if (eq === -1) {
			continue;
		}

		const key = line.slice(0, eq).trim().toLowerCase();
		const value = line.slice(eq + 1).trim();

		if (key === "email") {
			email = value;
		} else if (key === "name") {
			name = value;
		}
	}

	const source = email !== undefined ? email.split("@")[0] : name;

	return source === undefined ? undefined : slugify(source);
}

function slugify(value: string): string | undefined {
	const slug = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

	return slug === "" ? undefined : slug;
}

// ── policy: base contract + my overrides ─────────────────────────────────────────────────────────────────────

let baseCache: Policy | undefined;
let overrideCache: Policy | undefined;
let policyWatcher: vscode.Disposable | undefined;

/** Invalidate the policy caches when a `.silo/…policy.json` changes UNDER US — the panel edits the base contract
 *  from a SEPARATE extension bundle (so its writes don't touch these caches), and a user may hand-edit either
 *  file. Lazily installed for the session; matches both `policy.json` and `<user>.policy.json`. */
function ensurePolicyWatcher(): void {
	if (policyWatcher !== undefined) {
		return;
	}

	try {
		const watcher = vscode.workspace.createFileSystemWatcher("**/.silo/*policy.json");
		const invalidate = (): void => { baseCache = undefined; overrideCache = undefined; };

		watcher.onDidChange(invalidate);
		watcher.onDidCreate(invalidate);
		watcher.onDidDelete(invalidate);
		policyWatcher = watcher;
	} catch {
		policyWatcher = { "dispose": () => undefined }; // watcher API unavailable → skip (we simply keep our cache)
	}
}

async function loadBase(root: vscode.Uri): Promise<Policy> {
	if (baseCache === undefined) {
		const text = await readText(vscode.Uri.joinPath(root, "policy.json"));

		baseCache = text === undefined ? { ...EMPTY_POLICY } : parsePolicy(text);
	}

	return baseCache;
}

async function loadOverride(root: vscode.Uri, user: string): Promise<Policy> {
	if (overrideCache === undefined) {
		const text = await readText(vscode.Uri.joinPath(root, `${user}.policy.json`));

		overrideCache = text === undefined ? { ...EMPTY_POLICY } : parsePolicy(text);
	}

	return overrideCache;
}

/** The effective policy consulted at decision time: MY overrides layered over the base contract. Overrides go
 *  first because findRule is first-match — a personal grant beats the contract, the contract beats the computed
 *  default. With no workspace, the empty policy (everything → computed default). */
export async function loadEffectivePolicy(): Promise<Policy> {
	const root = siloRoot();

	if (root === undefined) {
		return { ...EMPTY_POLICY };
	}

	ensurePolicyWatcher();

	const base = await loadBase(root);
	const override = await loadOverride(root, await currentUser());

	return { "version": base.version, "rules": [...override.rules, ...base.rules] };
}

/** Persist a user decision to `<user>.policy.json` (NEVER policy.json — silo doesn't author the contract),
 *  stamping `added` on a first-time grant and preserving it across later flips. */
export async function persistOverride(capability: string, resource: string, disposition: Disposition): Promise<void> {
	const root = siloRoot();

	if (root === undefined) {
		return;
	}

	const user = await currentUser();

	overrideCache = withRule(await loadOverride(root, user), capability, resource, disposition, new Date().toISOString());
	await writeText(vscode.Uri.joinPath(root, `${user}.policy.json`), JSON.stringify(overrideCache, null, "\t") + "\n");
}

// ── static facts: the capability surface (committed, shared) ─────────────────────────────────────────────────

/** One statically-detected capability site: what a file CAN reach (from findReach, surfaced via the plugin's
 *  diagnostics). `resource` is "" when unresolved (a call whose target a run/literal hasn't pinned yet). No line
 *  number — the surface is "what capabilities/resources this file reaches", so it churns only on real DRIFT (a new
 *  capability or resource), not on every edit that shifts a line. */
export interface StaticEntry {
	"capability": string;
	"callee": string;
	"resource": string;
}
export interface StaticSurface {
	"version": number;
	"capabilities": Record<string, StaticEntry[]>;
}

/** Read `.silo/capabilities.json` (the committed STATIC surface), empty if absent/malformed. */
export async function loadStaticSurface(): Promise<StaticSurface> {
	const root = siloRoot();

	if (root === undefined) {
		return { "version": 1, "capabilities": {} };
	}

	const text = await readText(vscode.Uri.joinPath(root, "capabilities.json"));

	if (text !== undefined) {
		try {
			const parsed = JSON.parse(text) as Partial<StaticSurface>;

			if (parsed.capabilities !== undefined && typeof parsed.capabilities === "object") {
				return { "version": parsed.version ?? 1, "capabilities": parsed.capabilities };
			}
		} catch { /* malformed → empty */ }
	}

	return { "version": 1, "capabilities": {} };
}

/** Write `.silo/capabilities.json` with file keys AND each file's entries sorted, so the committed file diffs
 *  cleanly (drift shows as a real add/remove, never a reorder). */
export async function writeStaticSurface(surface: StaticSurface): Promise<void> {
	const root = siloRoot();

	if (root === undefined) {
		return;
	}

	const sorted: StaticSurface = { "version": surface.version, "capabilities": {} };

	for (const path of Object.keys(surface.capabilities).sort((a, b) => a.localeCompare(b))) {
		sorted.capabilities[path] = [...surface.capabilities[path]].sort((a, b) =>
			(a.capability + a.callee + a.resource).localeCompare(b.capability + b.callee + b.resource));
	}

	await writeText(vscode.Uri.joinPath(root, "capabilities.json"), JSON.stringify(sorted, null, "\t") + "\n");
}

// ── observed facts: the rollup + the firehose ────────────────────────────────────────────────────────────────

interface ObservedEntry {
	"kind": string;
	"resource": string;
	"firstObserved": string;
	"lastObserved": string;
}
interface ObservedSurface {
	"version": number;
	"observed": Record<string, ObservedEntry>;
}

let observedCache: ObservedSurface | undefined;

async function loadObserved(root: vscode.Uri, user: string): Promise<ObservedSurface> {
	if (observedCache === undefined) {
		observedCache = { "version": 1, "observed": {} };

		const text = await readText(vscode.Uri.joinPath(root, `${user}.capabilities.json`));

		if (text !== undefined) {
			try {
				const parsed = JSON.parse(text) as Partial<ObservedSurface>;

				if (parsed.observed !== undefined && typeof parsed.observed === "object") {
					observedCache = { "version": parsed.version ?? 1, "observed": parsed.observed };
				}
			} catch { /* malformed → empty */ }
		}
	}

	return observedCache;
}

// Per-run accumulation of distinct scopes, keyed by runId, drained into ONE run-grain record at flushRun. `scopes`
// FIRED (allowed); `denied` were attempted-but-blocked (kept for the attempt audit).
interface RunScopes {
	"scopes": Set<string>;
	"denied": Set<string>;
}
const runScopes = new Map<string, RunScopes>();

/**
 * Record one gated decision on the OBSERVED axis (best-effort, never blocks or fails a decision):
 *   • fold ALLOWED scopes into `<user>.capabilities.json` — the committed rollup, day-coarsened (rewritten only
 *     when a scope is first seen or its last-seen DATE advances) so the tracked file stays quiet in git.
 *   • when `runId` is known (an almostnode run), attribute the scope to that RUN — distinct scopes accumulate and a
 *     single run-grain record is written at flushRun, so `<user>.runs.jsonl` stays one-line-per-run, not per-call.
 *   • with NO runId (e.g. a preview app's own fetch, which belongs to no single run) append a call-grain line to
 *     `<user>.runs.jsonl` so nothing is lost.
 * A denied call fired nothing, so it's kept out of the observed surface (but is recorded as an attempt).
 */
export function recordObservation(request: CapabilityRequest, disposition: Disposition, runId?: string): void {
	// Attribute to the run SYNCHRONOUSLY (before any await) so a fast run-exit can't race the accumulation.
	if (runId !== undefined) {
		let bucket = runScopes.get(runId);

		if (bucket === undefined) {
			bucket = { "scopes": new Set(), "denied": new Set() };
			runScopes.set(runId, bucket);
		}

		(disposition === "allow" ? bucket.scopes : bucket.denied).add(request.scope);
	}

	void (async () => {
		try {
			const root = siloRoot();

			if (root === undefined) {
				return;
			}

			const now = new Date().toISOString();
			const user = await currentUser();

			// Runless observations have no run record to fold into → straight to the firehose, call-grain.
			if (runId === undefined) {
				await ensureGitignore(root);
				await appendLine(
					vscode.Uri.joinPath(root, `${user}.runs.jsonl`),
					JSON.stringify({ "type": "call", "ts": now, "scope": request.scope, "kind": request.kind, "resource": request.resource ?? "", "disposition": disposition })
				);
			}

			if (disposition !== "allow") {
				return; // denied ⇒ nothing fired ⇒ not part of the observed surface
			}

			const surface = await loadObserved(root, user);
			const entry = surface.observed[request.scope];

			if (entry === undefined) {
				surface.observed[request.scope] = { "kind": request.kind, "resource": request.resource ?? "", "firstObserved": now, "lastObserved": now };
			} else if (entry.lastObserved.slice(0, 10) !== now.slice(0, 10)) {
				entry.lastObserved = now; // advanced to a new day — worth persisting
			} else {
				return; // same scope, same day → the rollup already reflects this
			}

			await writeText(vscode.Uri.joinPath(root, `${user}.capabilities.json`), JSON.stringify(surface, null, "\t") + "\n");
		} catch { /* observation is advisory; a failure must never affect enforcement */ }
	})();
}

/**
 * Flush a finished run to `<user>.runs.jsonl` as ONE run-grain record — `{type:"run", ts, entry, sha, mode, exit,
 * scopes, denied?}` — correlating the code version (content sha of `entry`) with the distinct scopes it exercised,
 * for the "was I exposed to compromised dep X in window W" audit. Best-effort; clears the run's accumulation either
 * way. A run with no gated calls still gets a record (proof of a clean run).
 */
export function flushRun(runId: string, run: { "entry": string; "mode": string; "exit": number }): void {
	const bucket = runScopes.get(runId);

	runScopes.delete(runId);

	void (async () => {
		try {
			const root = siloRoot();

			if (root === undefined) {
				return;
			}

			const user = await currentUser();
			const record: Record<string, unknown> = {
				"type": "run",
				"ts": new Date().toISOString(),
				"entry": run.entry,
				"sha": await hashFile(run.entry),
				"mode": run.mode,
				"exit": run.exit,
				"scopes": bucket === undefined ? [] : [...bucket.scopes].sort((a, b) => a.localeCompare(b))
			};

			if (bucket !== undefined && bucket.denied.size > 0) {
				record["denied"] = [...bucket.denied].sort((a, b) => a.localeCompare(b));
			}

			await ensureGitignore(root);
			await appendLine(vscode.Uri.joinPath(root, `${user}.runs.jsonl`), JSON.stringify(record));
		} catch { /* advisory */ }
	})();
}

/** SHA-256 (first 12 hex — silo's convention) of a run's entry file, or "" if unreadable. Ties a run record to the
 *  exact code version that ran. `entry` is an absolute VFS path (e.g. /workspace/src/app.ts) or workspace-relative. */
async function hashFile(entry: string): Promise<string> {
	try {
		const folder = vscode.workspace.workspaceFolders?.[0];

		if (folder === undefined || typeof crypto === "undefined" || crypto.subtle === undefined) {
			return "";
		}

		const rel = entry.startsWith("/workspace/") ? entry.slice("/workspace/".length) : entry.replace(/^\/+/, "");
		const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, rel));
		const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);

		return [...new Uint8Array(digest)].slice(0, 6).map((byte) => byte.toString(16).padStart(2, "0")).join("");
	} catch {
		return "";
	}
}

/** Append a line (workspace.fs has no append; read-concat-write — fine at observation volume, the fast-pathed
 *  workspace reads never reach the gate). */
async function appendLine(uri: vscode.Uri, line: string): Promise<void> {
	const existing = (await readText(uri)) ?? "";

	await writeText(uri, existing + line + "\n");
}

let gitignoreEnsured = false;

/** silo self-manages `.silo/.gitignore` so the firehose stays out of git without the user configuring anything. */
async function ensureGitignore(root: vscode.Uri): Promise<void> {
	if (gitignoreEnsured) {
		return;
	}

	gitignoreEnsured = true;

	const uri = vscode.Uri.joinPath(root, ".gitignore");
	const existing = (await readText(uri)) ?? "";

	if (!existing.split(/\r?\n/).some((entry) => entry.trim() === "*.runs.jsonl")) {
		await writeText(uri, (existing === "" ? "" : existing.replace(/\n?$/, "\n")) + "*.runs.jsonl\n");
	}
}

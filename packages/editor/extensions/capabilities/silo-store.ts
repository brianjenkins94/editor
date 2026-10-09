/**
 * `.silo/` store — the on-disk capability layout the editor owns as silo's FIRST-CLASS harness (no silo CLI
 * exists; this is the reference writer). Two independent axes, and the layout keeps each axis's base/derived
 * halves apart because the GAP between them is the security signal:
 *
 *   .silo/
 *     policy.json               DECISIONS · base    — the contract, human-authored (we only READ it — but for keeping a
 *                                                   placed rule's place up with its code: movePlace)
 *     <user>.policy.json        DECISIONS · mine    — overrides; "Allow always"/"Deny always" write HERE
 *     capabilities.json         FACTS · static      — what analysis says code CAN do (written by the panel side)
 *     <user>.capabilities.json  FACTS · observed    — what I actually saw FIRE (rollup, day-coarsened)
 *     .gitignore                silo-managed        — ignores local/ (recorded results: this machine's alone)
 *
 * Why never merge the axes:
 *   • base vs override — silo must never rewrite the reviewable CONTRACT; a person's grants land in their own
 *     git-user-scoped file, so overrides commit conflict-free (everyone writes only their file).
 *   • static vs observed — a scope OBSERVED with no matching STATIC entry is the alarm (dynamic eval, obfuscation,
 *     a supply-chain payload that reads clean and runs dirty). Merged, that signal is gone.
 *
 * Timestamps land per axis, each answering a different question: `added` (when I authorized) on the override
 * rule; firstObserved/lastObserved (when it fired) on the observed rollup; and per run, in the one run ledger: each
 * run's envelope (`.silo/runs/<user>.jsonl`, evidence.ts) lists its effects — what it made, was denied, skipped or was
 * given — kept here while it runs (recordEffect) and taken when its envelope is written (takeEffects, `run.effects`).
 * "lastAllowed" and "was I exposed to compromised dep X in window W" are QUERIES over the observed side, never stored
 * decision state.
 *
 * MONOREPO-READY: siloRoot() is the one place the responsible `.silo` is resolved. Today it's the single
 * workspace root; later it resolves the nearest `.silo` walking up from a run's entry, so a monorepo can carry a
 * root `.silo` plus per-package ones without any schema change. No caller assumes a single root.
 */
import type { CapabilityRequest } from "@brianjenkins94/util/silo/enforce/broker";
import type { Disposition, Policy, Rule } from "@brianjenkins94/util/silo/policy";
import * as vscode from "vscode";
import type { Effect } from "@brianjenkins94/util/silo/evidence";
import { userSlug } from "@brianjenkins94/util/silo/evidence";
import { EMPTY_POLICY, parsePolicy, withRule } from "@brianjenkins94/util/silo/policy";

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
		const slug = config === undefined ? undefined : userSlug(config);

		if (slug !== undefined) {
			userCache = slug;
		}
	}

	return userCache;
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

/** The policy files, apart: mine (`.silo/<user>.policy.json`) and the shared contract (`.silo/policy.json`), each with
 *  its workspace-relative path — for a view listing every rule. With no workspace, none. */
export async function loadPolicyFiles(): Promise<{ "mine": { "file": string; "rules": Rule[] }; "shared": { "file": string; "rules": Rule[] } } | undefined> {
	const root = siloRoot();

	if (root === undefined) {
		return undefined;
	}

	ensurePolicyWatcher();

	const user = await currentUser();
	const relative = (name: string): string => vscode.workspace.asRelativePath(vscode.Uri.joinPath(root, name), false);

	return {
		"mine": { "file": relative(`${user}.policy.json`), "rules": (await loadOverride(root, user)).rules },
		"shared": { "file": relative("policy.json"), "rules": (await loadBase(root)).rules }
	};
}

/** Persist a user decision to `<user>.policy.json` (NEVER policy.json — silo doesn't author the contract),
 *  stamping `added` on a first-time grant and preserving it across later flips. */
export async function persistOverride(capability: string, resource: string, disposition: Disposition): Promise<void> {
	const root = siloRoot();

	if (root === undefined) {
		return;
	}

	const user = await currentUser();

	// Written from the file as it is now, not the cache: a change by hand (or a delete) the watcher hasn't reported yet
	// must not come back.
	overrideCache = undefined;
	overrideCache = withRule(await loadOverride(root, user), capability, resource, disposition, new Date().toISOString());
	await writeText(vscode.Uri.joinPath(root, `${user}.policy.json`), JSON.stringify(overrideCache, null, "\t") + "\n");
}

/** The same rule, whenever it was decided. */
const sameRule = (a: Rule, b: Rule): boolean => JSON.stringify({ "when": a.when, "then": a.then }) === JSON.stringify({ "when": b.when, "then": b.then });

/** Change my policy (`<user>.policy.json`) by a rule made in a rule editor: `previous` (the rule edited, if it's mine)
 *  replaced by `rule`, in its place — or, with no `previous` of mine, `rule` added first (a rule just made is the one
 *  meant; one edited from the shared contract shadows it); with no `rule`, `previous` removed. A new or changed rule is
 *  stamped as decided now. */
export async function replaceRule(previous: Rule | undefined, rule: Rule | undefined): Promise<void> {
	const root = siloRoot();

	if (root === undefined) {
		return;
	}

	const user = await currentUser();

	// From the file as it is now, not the cache (as persistOverride).
	overrideCache = undefined;

	const override = await loadOverride(root, user);
	const index = previous === undefined ? -1 : override.rules.findIndex((each) => sameRule(each, previous));
	const stamped = rule === undefined ? [] : [{ ...rule, "added": new Date().toISOString() }];
	const rules = index === -1 ? [...stamped, ...override.rules] : [...override.rules.slice(0, index), ...stamped, ...override.rules.slice(index + 1)];

	overrideCache = { "version": override.version, "rules": rules };
	await writeText(vscode.Uri.joinPath(root, `${user}.policy.json`), JSON.stringify(overrideCache, null, "\t") + "\n");
}

/** Keep a placed rule's place up with its code (RULES.md: a placed rule keeps its place on its own): `previous`, in my
 *  policy or the shared contract (`whose`), replaced in its place by `rule` — the same rule at the place its code was
 *  followed to, its `added` kept (moving a place isn't deciding anything). The one write silo makes to the contract:
 *  not a decision, a re-anchoring — committed with the code change that moved the code, as its reviewers would want. */
export async function movePlace(whose: "mine" | "shared", previous: Rule, rule: Rule): Promise<void> {
	const root = siloRoot();

	if (root === undefined) {
		return;
	}

	const name = whose === "mine" ? `${await currentUser()}.policy.json` : "policy.json";
	const text = await readText(vscode.Uri.joinPath(root, name));
	const policy = text === undefined ? undefined : parsePolicy(text);
	const index = policy?.rules.findIndex((each) => sameRule(each, previous)) ?? -1;

	if (policy === undefined || index === -1) {
		return; // changed since it was read: left for the next save
	}

	const moved = { "version": policy.version, "rules": policy.rules.map((each, at) => (at === index ? rule : each)) };

	baseCache = undefined;
	overrideCache = undefined;
	await writeText(vscode.Uri.joinPath(root, name), JSON.stringify(moved, null, "\t") + "\n");
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

// ── observed facts: the rollup + each run's effects ────────────────────────────────────────────────────────────────

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

// Each run's effects (util/silo/evidence's `Effect`), by run id, until its envelope is written: each capability and
// resource once per way it went, with how many calls went that way.
const runEffects = new Map<string, Map<string, Effect>>();

/** A gated call `runId` made (a debug run's, reported by its adapter; a preview's, by the gate), and how it went. */
export function recordEffect(runId: string, capability: string, resource: string, how: Effect["how"], calls = 1): void {
	let effects = runEffects.get(runId);

	if (effects === undefined) {
		effects = new Map();
		runEffects.set(runId, effects);
	}

	const key = `${how}\0${capability}\0${resource}`;
	const known = effects.get(key);

	if (known === undefined) {
		effects.set(key, { "capability": capability, "resource": resource, "how": how, "calls": calls });
	} else {
		known.calls += calls;
	}
}

/** `runId`'s effects, taken (as its envelope is written: `run.effects`) — made first, then denied, skipped, given. */
export function takeEffects(runId: string): Effect[] {
	const effects = [...runEffects.get(runId)?.values() ?? []];
	const order = ["made", "denied", "skipped", "given"];

	runEffects.delete(runId);

	return effects.toSorted((a, b) => order.indexOf(a.how) - order.indexOf(b.how) || a.capability.localeCompare(b.capability) || a.resource.localeCompare(b.resource));
}

/**
 * Record one gated decision on the OBSERVED axis (best-effort, never blocks or fails a decision):
 *   • fold ALLOWED scopes into `<user>.capabilities.json` — the committed rollup, day-coarsened (rewritten only
 *     when a scope is first seen or its last-seen DATE advances) so the tracked file stays quiet in git.
 *   • when `runId` is known (a preview's run), count it among that run's effects (recordEffect) — made, or denied.
 * A denied call fired nothing, so it's kept out of the observed surface.
 */
export function recordObservation(request: CapabilityRequest, disposition: Disposition, runId?: string): void {
	// Counted SYNCHRONOUSLY (before any await) so a fast run-exit can't race it.
	if (runId !== undefined) {
		recordEffect(runId, request.kind === "fs" ? `fs:${request.op ?? "read"}` : request.kind, request.resource ?? "", disposition === "allow" ? "made" : "denied");
	}

	void (async () => {
		try {
			const root = siloRoot();

			if (root === undefined) {
				return;
			}

			const now = new Date().toISOString();
			const user = await currentUser();

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

let gitignoreEnsured = false;

/** silo self-manages `.silo/.gitignore` so what's this machine's alone stays out of git without the user configuring it. */
async function ensureGitignore(root: vscode.Uri): Promise<void> {
	if (gitignoreEnsured) {
		return;
	}

	gitignoreEnsured = true;

	const uri = vscode.Uri.joinPath(root, ".gitignore");
	let existing = (await readText(uri)) ?? "";

	// What's this machine's alone (recorded results can hold secrets).
	for (const entry of ["local/"]) {
		if (!existing.split(/\r?\n/).some((each) => each.trim() === entry)) {
			existing = (existing === "" ? "" : existing.replace(/\n?$/, "\n")) + entry + "\n";
			await writeText(uri, existing);
		}
	}
}

// ── recorded results: what calls returned when they ran for real (RULES.md, slice 2) ───────────────────────────────

interface Recorded { "version": 1; "results": Record<string, { "value": unknown; "at": string }> }

/** At most this many calls' results are kept: the oldest go first. */
const RECORDED_MAX = 200;

const recordedUri = (root: vscode.Uri): vscode.Uri => vscode.Uri.joinPath(root, "local", "recorded.json");

async function loadRecorded(root: vscode.Uri): Promise<Recorded> {
	try {
		const parsed = JSON.parse(await readText(recordedUri(root)) ?? "{}") as Partial<Recorded>;

		return { "version": 1, "results": parsed.results ?? {} };
	} catch {
		return { "version": 1, "results": {} };
	}
}

/** Keep what a call returned when it ran for real (a preview's fetch: its body, parsed when it's JSON; a script's read of
 *  a workspace file: its text) — the latest of
 *  each call, in `.silo/local/recorded.json`: this machine's only, never committed (a real response can hold secrets). */
export async function recordResult(capability: string, resource: string, value: unknown): Promise<void> {
	// One after another: a script's reads come quickly, and each rewrites the file from what's in it.
	const write = recording.then(() => recordNow(capability, resource, value));

	recording = write.catch(() => undefined);

	return write;
}

/** The record being written, which the next waits for. */
let recording: Promise<unknown> = Promise.resolve();

async function recordNow(capability: string, resource: string, value: unknown): Promise<void> {
	const root = siloRoot();

	if (root === undefined) {
		return;
	}

	await ensureGitignore(root);

	const recorded = await loadRecorded(root);
	const key = `${capability} ${resource}`;

	delete recorded.results[key];
	recorded.results[key] = { "value": value, "at": new Date().toISOString() };

	const keys = Object.keys(recorded.results);

	for (const old of keys.slice(0, Math.max(0, keys.length - RECORDED_MAX))) {
		delete recorded.results[old];
	}

	await writeText(recordedUri(root), JSON.stringify(recorded, null, "\t") + "\n");
}

/** What a call returned the last time it ran for real, and when — undefined if it's never been recorded. */
export async function recordedResult(capability: string, resource: string): Promise<{ "value": unknown; "at": string } | undefined> {
	const root = siloRoot();

	return root === undefined ? undefined : (await loadRecorded(root)).results[`${capability} ${resource}`];
}

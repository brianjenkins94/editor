/**
 * `.silo/` store — the capability decisions the editor keeps for a project, base and override apart:
 *
 *   .silo/
 *     policy.json               DECISIONS · base    — the contract, human-authored (we only READ it — but for keeping a
 *                                                   placed rule's place up with its code: movePlace)
 *     policy/<user>.json        DECISIONS · mine    — overrides; "Allow always"/"Deny always" write HERE
 *     .gitignore                silo-managed        — ignores local/ (recorded results: this machine's alone)
 *
 * (The whole `.silo/` layout, and who writes what, is silo's: @brianjenkins94/util/silo/layout.)
 *
 * Why never merge them: silo must never rewrite the reviewable CONTRACT; a person's grants land in their own
 * git-user-scoped file, so overrides commit conflict-free (everyone writes only their file).
 *
 * What the code CAN do isn't stored: it's read off the code when it's asked (lib's `detect`). What it DID is each run's:
 * its envelope (`.silo/runs/<user>.jsonl`, evidence.ts) lists its effects — what it made, was denied, skipped or was
 * given — kept while it runs (run-effects.ts) and taken when its envelope is written (`run.effects`). The gap between the
 * two is asked of both (a feature's "can … not in its tests' runs"; an allow rule no run used), and "was I exposed to
 * compromised dep X in window W" is a query over the runs. (A stored static surface, `capabilities.json`, and an observed
 * rollup, `capabilities/<user>.json`, went 2026-11-22: neither had a reader.)
 *
 * MONOREPO-READY: siloRoot() is the one place the responsible `.silo` is resolved. Today it's the single
 * workspace root; later it resolves the nearest `.silo` walking up from a run's entry, so a monorepo can carry a
 * root `.silo` plus per-package ones without any schema change. No caller assumes a single root.
 */
import type { CapabilityRequest } from "@brianjenkins94/util/silo/enforce/broker";
import type { Effect } from "@brianjenkins94/util/silo/evidence";
import type { Disposition, Policy, Rule } from "@brianjenkins94/util/silo/policy";
import { userSlug } from "@brianjenkins94/util/silo/evidence";
import { GITIGNORE, policyPath, SILO_DIR, userPolicyPath, withLines } from "@brianjenkins94/util/silo/layout";
import { EMPTY_POLICY, parsePolicy, withRule } from "@brianjenkins94/util/silo/policy";
import * as vscode from "vscode";
import { recordEffect } from "./effects.ts";
import { recordingKey } from "./gate.ts";

// ── paths ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The responsible `.silo` directory. MONOREPO SEAM: resolve the nearest one walking up from a run's entry here
 *  later; for now the single workspace root. Returns undefined with no workspace (nothing to persist). */
function siloRoot(): vscode.Uri | undefined {
	const folder = vscode.workspace.workspaceFolders?.[0];

	return folder === undefined ? undefined : vscode.Uri.joinPath(folder.uri, ".silo");
}

/** A layout path (`.silo/…`, silo's layout) as a file under the responsible `.silo`. */
const fileIn = (root: vscode.Uri, layoutPath: string): vscode.Uri => vscode.Uri.joinPath(root, layoutPath.slice(SILO_DIR.length + 1));

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
		await readUser(folder);
	}

	return userCache;
}

/** `currentUser`'s read of `folder`'s `.git/config`: its user, when it names one. */
async function readUser(folder: vscode.WorkspaceFolder): Promise<void> {
	const config = await readText(vscode.Uri.joinPath(folder.uri, ".git", "config"));
	const slug = config === undefined ? undefined : userSlug(config);

	if (slug !== undefined) {
		userCache = slug;
	}
}

// ── policy: base contract + my overrides ─────────────────────────────────────────────────────────────────────

/** Each policy file as last read, with its text then — kept while the file's text is the same. More than one bundle has
 *  its own copy of this module (the bridge's decider, the capabilities extension's rules, the margin's places), each
 *  writing the files: a file watcher reports another's write too late for the next decision, a read doesn't. */
const policies = new Map<string, { "policy": Policy; "text": string | undefined }>();

/** A policy file, parsed again only when its text changed. Read each time: it's small, and a stamp (mtime and size)
 *  can miss a rewrite — a rule's place moved keeps its file's size, and a write in the same millisecond its mtime — so
 *  a run started just after "Put the rule back here" went without the rule. */
async function loadPolicy(uri: vscode.Uri): Promise<Policy> {
	const text = await readText(uri);
	const cached = policies.get(uri.toString());

	if (cached !== undefined && cached.text === text) {
		return cached.policy;
	}

	const policy = text === undefined ? { ...EMPTY_POLICY } : parsePolicy(text);

	policies.set(uri.toString(), { "policy": policy, "text": text });

	return policy;
}

async function loadBase(root: vscode.Uri): Promise<Policy> {
	return loadPolicy(fileIn(root, policyPath()));
}

async function loadOverride(root: vscode.Uri, user: string): Promise<Policy> {
	return loadPolicy(fileIn(root, userPolicyPath(user)));
}

/** Write my policy file as `policy`, kept as it's written. */
async function writeOverride(root: vscode.Uri, user: string, policy: Policy): Promise<void> {
	const uri = fileIn(root, userPolicyPath(user));

	const text = JSON.stringify(policy, null, "\t") + "\n";

	await writeText(uri, text);
	policies.set(uri.toString(), { "policy": policy, "text": text });
}

/** The effective policy consulted at decision time: MY overrides layered over the base contract. Overrides go
 *  first because findRule is first-match — a personal grant beats the contract, the contract beats the computed
 *  default. With no workspace, the empty policy (everything → computed default). */
export async function loadEffectivePolicy(): Promise<Policy> {
	const root = siloRoot();

	if (root === undefined) {
		return { ...EMPTY_POLICY };
	}

	const base = await loadBase(root);
	const override = await loadOverride(root, await currentUser());

	return { "version": base.version, "rules": [...override.rules, ...base.rules] };
}

/** The policy files, apart: mine (`.silo/policy/<user>.json`) and the shared contract (`.silo/policy.json`), each with
 *  its workspace-relative path — for a view listing every rule. With no workspace, none. */
export async function loadPolicyFiles(): Promise<{ "mine": { "file": string; "rules": Rule[] }; "shared": { "file": string; "rules": Rule[] } } | undefined> {
	const root = siloRoot();

	if (root === undefined) {
		return undefined;
	}

	const user = await currentUser();
	const relative = (file: vscode.Uri): string => vscode.workspace.asRelativePath(file, false);

	return {
		"mine": { "file": relative(fileIn(root, userPolicyPath(user))), "rules": (await loadOverride(root, user)).rules },
		"shared": { "file": relative(fileIn(root, policyPath())), "rules": (await loadBase(root)).rules }
	};
}

/** Persist a user decision to `policy/<user>.json` (NEVER policy.json — silo doesn't author the contract),
 *  stamping `added` on a first-time grant and preserving it across later flips. */
export async function persistOverride(capability: string, resource: string, disposition: Disposition, about: Record<string, string> = {}): Promise<void> {
	const root = siloRoot();

	if (root === undefined) {
		return;
	}

	const user = await currentUser();

	await writeOverride(root, user, withRule(await loadOverride(root, user), capability, resource, disposition, new Date().toISOString(), about));
}

/** The same rule, whenever it was decided. */
const sameRule = (left: Rule, right: Rule): boolean => JSON.stringify({ "when": left.when, "then": left.then }) === JSON.stringify({ "when": right.when, "then": right.then });

/** Change my policy (`policy/<user>.json`) by a rule made in a rule editor: `previous` (the rule edited, if it's mine)
 *  replaced by `rule`, in its place — or, with no `previous` of mine, `rule` added first (a rule just made is the one
 *  meant; one edited from the shared contract shadows it); with no `rule`, `previous` removed. A new or changed rule is
 *  stamped as decided now. */
export async function replaceRule(previous: Rule | undefined, rule: Rule | undefined): Promise<void> {
	const root = siloRoot();

	if (root === undefined) {
		return;
	}

	const user = await currentUser();

	const override = await loadOverride(root, user);
	const index = previous === undefined ? -1 : override.rules.findIndex((each) => sameRule(each, previous));
	const stamped = rule === undefined ? [] : [{ ...rule, "added": new Date().toISOString() }];
	const rules = index === -1 ? [...stamped, ...override.rules] : [...override.rules.slice(0, index), ...stamped, ...override.rules.slice(index + 1)];

	await writeOverride(root, user, { "version": override.version, "rules": rules });
}

/** Keep a placed rule's place up with its code (packages/editor/RUNNING.md, *A placed rule keeps its place on its
 *  own*): `previous`, in my policy or the shared contract (`whose`), replaced in its place by `rule` — the same rule at
 *  the place its code was followed to, its `added` kept (moving a place isn't deciding anything). The one write silo
 *  makes to the contract: not a decision, a re-anchoring — committed with the code change that moved the code, as its
 *  reviewers would want. */
export async function movePlace(whose: "mine" | "shared", previous: Rule, rule: Rule): Promise<void> {
	const root = siloRoot();

	if (root === undefined) {
		return;
	}

	const file = fileIn(root, whose === "mine" ? userPolicyPath(await currentUser()) : policyPath());
	const text = await readText(file);
	const policy = text === undefined ? undefined : parsePolicy(text);
	const index = policy?.rules.findIndex((each) => sameRule(each, previous)) ?? -1;

	if (policy === undefined || index === -1) {
		return; // changed since it was read: left for the next save
	}

	const moved = { "version": policy.version, "rules": policy.rules.map((each, at) => (at === index ? rule : each)) };

	await writeText(file, JSON.stringify(moved, null, "\t") + "\n");
}

/** Record one gated decision: when `runId` is known (a preview's run), counted among that run's effects (recordEffect) —
 *  made, or denied. */
export function recordObservation(request: CapabilityRequest, disposition: Disposition, runId?: string, decided?: Effect["decided"]): void {
	// Counted SYNCHRONOUSLY so a fast run-exit can't race it — with how it was decided (an answer at the call is an
	// exception to the policy, on record in the run).
	if (runId !== undefined) {
		recordEffect(runId, request.kind === "fs" ? `fs:${request.op ?? "read"}` : request.kind, request.resource ?? "", disposition === "allow" ? "made" : "denied", 1, decided);
	}
}

let gitignoreEnsured = false;

/** silo self-manages `.silo/.gitignore` so what's this machine's alone stays out of git without the user configuring it. */
async function ensureGitignore(root: vscode.Uri): Promise<void> {
	if (gitignoreEnsured) {
		return;
	}

	gitignoreEnsured = true;

	// What's this machine's alone (recorded results can hold secrets): silo's own `.gitignore` lines, a person's kept.
	const uri = vscode.Uri.joinPath(root, ".gitignore");
	const updated = withLines((await readText(uri)) ?? "", GITIGNORE);

	if (updated !== undefined) {
		await writeText(uri, updated);
	}
}

// ── recorded results: what calls returned when they ran for real (packages/editor/RUNNING.md, *A call's result*) ─────

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

/** The record being written, which the next waits for. */
let recording: Promise<unknown> = Promise.resolve();

/** Keep what a call returned when it ran for real (a preview's fetch: its body, parsed when it's JSON; a script's read of
 *  a workspace file: its text) — the latest of
 *  each call, in `.silo/local/recorded.json`: this machine's only, never committed (a real response can hold secrets). */
export async function recordResult(capability: string, resource: string, value: unknown, request?: string): Promise<void> {
	// One after another: a script's reads come quickly, and each rewrites the file from what's in it.
	const write = recording.then(() => recordNow(capability, resource, value, request));

	recording = write.catch(() => undefined);

	return write;
}

async function recordNow(capability: string, resource: string, value: unknown, request?: string): Promise<void> {
	const root = siloRoot();

	if (root === undefined) {
		return;
	}

	await ensureGitignore(root);

	const recorded = await loadRecorded(root);
	const key = recordingKey(capability, resource, request);

	delete recorded.results[key];
	recorded.results[key] = { "value": value, "at": new Date().toISOString() };

	const keys = Object.keys(recorded.results);

	for (const old of keys.slice(0, Math.max(0, keys.length - RECORDED_MAX))) {
		delete recorded.results[old];
	}

	await writeText(recordedUri(root), JSON.stringify(recorded, null, "\t") + "\n");
}

/** Every call's recorded result, by `<capability> <resource>` and its request when it has one (gate.ts' recordingKey): what a run nobody's watching (a live run) gives a call
 *  back in its place (RUNNING.md, unattended runs). */
export async function recordedResults(): Promise<Record<string, unknown>> {
	const root = siloRoot();

	return root === undefined ? {} : Object.fromEntries(Object.entries((await loadRecorded(root)).results).map(([key, { value }]) => [key, value]));
}

/** What a call returned the last time it ran for real, and when — undefined if it's never been recorded. `request`: a
 *  request other than a plain read (gate.ts' requestOf). */
export async function recordedResult(capability: string, resource: string, request?: string): Promise<{ "value": unknown; "at": string } | undefined> {
	const root = siloRoot();

	return root === undefined ? undefined : (await loadRecorded(root)).results[recordingKey(capability, resource, request)];
}

import type { HttpClient } from "isomorphic-git";
// eslint-disable-next-line node/prefer-global/buffer -- the browser has NO global Buffer; this import IS the polyfill we assign to globalThis below (isomorphic-git needs it)
import { Buffer } from "node:buffer";
import { latestVouches, PENDING_VOUCHES } from "@brianjenkins94/editor-api/git";
import { userSlug } from "@brianjenkins94/util/silo/evidence";
import { LOCAL_DIR, SILO_DIR, vouchesPath } from "@brianjenkins94/util/silo/layout";
import { parseVouches, vouchesText } from "@brianjenkins94/util/silo/select";
import { fs as zenfs } from "@zenfs/core";
import { add, branch, checkout, commit, currentBranch, deleteRef, Errors, expandOid, getConfig, fetch as gitFetch, push as gitPush, hashBlob, init, isDescendent, listBranches, log, merge, readBlob, readCommit, readTree, remove, resetIndex, resolveRef, setConfig, STAGE, statusMatrix, TREE, updateIndex, walk, writeBlob, writeRef } from "isomorphic-git";
import { callerFs } from "../shared/fs-caller";

const fs = callerFs(zenfs, "git");

// eslint-disable-next-line ts/naming-convention -- the Buffer global isomorphic-git expects, node's name
(globalThis as unknown as { "Buffer"?: unknown }).Buffer ??= Buffer;

const DIR = "/workspace";
const MERGE_HEAD = `${DIR}/.git/MERGE_HEAD`;
const AUTHOR = { "name": "editor", "email": "editor@localhost" };

let authorOf: () => Promise<{ "name": string; "email": string } | undefined> = () => Promise.resolve(undefined);

export function setAuthor(source: typeof authorOf): void {
	authorOf = source;
}

export async function recordIdentity(who: { "name": string; "email": string }): Promise<void> {
	if (!fs.existsSync(DIR + "/.git")) {
		return;
	}

	for (const [path, value] of [["user.name", who.name], ["user.email", who.email]] as const) {
		if (await getConfig({ "fs": fs, "dir": DIR, "path": path }) !== value) {
			await setConfig({ "fs": fs, "dir": DIR, "path": path, "value": value });
		}
	}
}

export interface GitChange { "path": string; "status": "A" | "M" | "D" }
export interface GitStatus { "staged": GitChange[]; "unstaged": GitChange[] }

export const DEFAULT_GITIGNORE = "node_modules/\n";

const LOCAL_EXCLUDE = `/${LOCAL_DIR}/`;

export async function includeSilo(): Promise<void> {
	const file = DIR + "/.git/info/exclude";

	if (fs.existsSync(DIR + "/.git")) {
		const lines = fs.existsSync(file) ? (await fs.promises.readFile(file, "utf8")).split("\n") : [];
		const kept = lines.filter((line) => line !== ".silo/");
		const wanted = kept.includes(LOCAL_EXCLUDE) ? kept : [...kept.filter((line, at) => line !== "" || at < kept.length - 1), LOCAL_EXCLUDE, ""];

		if (wanted.join("\n") !== lines.join("\n")) {
			await fs.promises.mkdir(DIR + "/.git/info", { "recursive": true });
			await fs.promises.writeFile(file, wanted.join("\n"));
		}
	}
}

export async function ensureRepo(): Promise<void> {
	if (!fs.existsSync(DIR + "/.git")) {
		await init({ "fs": fs, "dir": DIR, "defaultBranch": "main" });
	}

	if (!fs.existsSync(DIR + "/.gitignore")) {
		await fs.promises.writeFile(DIR + "/.gitignore", DEFAULT_GITIGNORE);
	}

	await includeSilo();
}

function letterFor(head: number, workdir: number): "A" | "M" | "D" {
	if (head === 0) {
		return "A";
	}

	return workdir === 0 ? "D" : "M";
}

function stagedLetterFor(head: number, stage: number): "A" | "M" | "D" {
	if (stage === 0) {
		return "D";
	}

	return head === 0 ? "A" : "M";
}

function readingIgnoresOnce(): typeof fs {
	const seen = new Map<string, Promise<unknown>>();
	const promises = new Proxy(fs.promises, {
		"get": (target, name) => {
			const method = Reflect.get(target, name) as (path: unknown, ...rest: unknown[]) => Promise<unknown>;

			if (name !== "readFile" && name !== "stat" && name !== "lstat") {
				return method;
			}

			return (path: unknown, ...rest: unknown[]): Promise<unknown> => {
				if (!/(?:^|\/)\.gitignore$|\/\.git\/info\/exclude$/u.test(String(path))) {
					return method.call(target, path, ...rest);
				}

				const key = `${name}\0${String(path)}\0${JSON.stringify(rest)}`;

				if (!seen.has(key)) {
					seen.set(key, method.call(target, path, ...rest));
				}

				return seen.get(key);
			};
		}
	});

	return { ...fs, "promises": promises };
}

type StatusRow = Awaited<ReturnType<typeof statusMatrix>>[number];

let known: { "stamp": string; "rows": Map<string, StatusRow> } | undefined;

async function stampOf(): Promise<string> {
	const index = await fs.promises.stat(`${DIR}/.git/index`).then((stat) => `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`, () => "none");
	const head = await resolveRef({ "fs": fs, "dir": DIR, "ref": "HEAD" }).catch(() => "none");

	return `${index} ${head}`;
}

export async function status(changed?: readonly string[]): Promise<GitStatus> {
	const stamp = await stampOf();
	let rows: Map<string, StatusRow>;

	if (changed !== undefined && known !== undefined && known.stamp === stamp) {
		rows = new Map(known.rows);

		if (changed.length > 0) {
			for (const path of rows.keys()) {
				if (changed.some((each) => path === each || path.startsWith(`${each}/`))) {
					rows.delete(path);
				}
			}

			for (const row of await statusMatrix({ "fs": readingIgnoresOnce(), "dir": DIR, "filepaths": [...changed] })) {
				rows.set(row[0], row);
			}
		}
	} else {
		rows = new Map((await statusMatrix({ "fs": readingIgnoresOnce(), "dir": DIR })).map((row) => [row[0], row]));
	}

	known = { "stamp": await stampOf(), "rows": rows };

	const staged: GitChange[] = [];
	const unstaged: GitChange[] = [];

	for (const [path, head, workdir, stage] of rows.values()) {
		if (head !== 1 || workdir !== 1 || stage !== 1) {
			if (workdir !== stage) {
				unstaged.push({ "path": path, "status": letterFor(head, workdir) });
			}

			if (stage !== head) {
				staged.push({ "path": path, "status": stagedLetterFor(head, stage) });
			}
		}
	}

	return { "staged": staged, "unstaged": unstaged };
}

export async function stageAll(): Promise<void> {
	const { unstaged } = await status();
	const withSilo = unstaged.some(({ path }) => path.startsWith(`${SILO_DIR}/`) && !SEEDS.includes(path));

	for (const change of unstaged.filter(({ path }) => withSilo || !SEEDS.includes(path))) {
		if (change.status === "D") {
			await remove({ "fs": fs, "dir": DIR, "filepath": change.path });
		} else {
			await add({ "fs": fs, "dir": DIR, "filepath": change.path });
		}
	}
}

export async function unstage(path: string): Promise<void> {
	await resetIndex({ "fs": fs, "dir": DIR, "filepath": path });
}

export async function stagePaths(paths: string[]): Promise<void> {
	for (const path of paths) {
		if (fs.existsSync(DIR + "/" + path)) {
			await add({ "fs": fs, "dir": DIR, "filepath": path });
		} else {
			await remove({ "fs": fs, "dir": DIR, "filepath": path });
		}
	}
}

async function readText(path: string): Promise<string | undefined> {
	try {
		return await fs.promises.readFile(`${DIR}/${path}`, "utf8");
	} catch {
		return undefined;
	}
}

const SEEDS = [`${SILO_DIR}/.gitignore`, `${SILO_DIR}/.gitattributes`];

async function stageSiloSeeds(): Promise<void> {
	if (!(await status()).staged.some(({ path }) => path.startsWith(`${SILO_DIR}/`) && !SEEDS.includes(path))) {
		return;
	}

	for (const seed of SEEDS) {
		if (await readText(seed) !== undefined) {
			await add({ "fs": fs, "dir": DIR, "filepath": seed }).catch(() => undefined);
		}
	}
}

async function stageVouches(): Promise<boolean> {
	const pending = parseVouches(await readText(PENDING_VOUCHES) ?? "");

	if (pending.length === 0) {
		return false;
	}

	const user = userSlug(await readText(".git/config") ?? "") ?? "local";
	const path = vouchesPath(user);

	await fs.promises.mkdir(`${DIR}/${path.slice(0, path.lastIndexOf("/"))}`, { "recursive": true });
	const before = await readText(path) ?? "";

	await fs.promises.writeFile(`${DIR}/${path}`, vouchesText(latestVouches(parseVouches(before), pending.map((vouch) => ({ ...vouch, "by": user }))), before));
	await add({ "fs": fs, "dir": DIR, "filepath": path });

	return true;
}

export interface Committed { "oid": string }

async function keepExecutables(): Promise<void> {
	if (await resolveRef({ "fs": fs, "dir": DIR, "ref": "HEAD" }).catch(() => undefined) === undefined) {
		return;
	}

	const lost: { "path": string; "oid": string }[] = [];

	await walk({
		"fs": fs,
		"dir": DIR,
		"trees": [TREE({ "ref": "HEAD" }), STAGE()],
		"map": async (path, [head, staged]) => {
			if (head !== null && staged !== null && await head.type() === "blob" && await head.mode() === 0o100755 && await staged.mode() !== 0o100755) {
				lost.push({ "path": path, "oid": await staged.oid() });
			}

			return true;
		}
	});

	for (const { path, oid } of lost) {
		await updateIndex({ "fs": fs, "dir": DIR, "filepath": path, "oid": oid, "mode": 0o100755, "add": true });
	}
}

async function committed(message: string): Promise<Committed> {
	const author = await authorOf().catch(() => undefined);

	if (author !== undefined) {
		await recordIdentity(author).catch(() => { /* the commit's author is what matters here */ });
	}

	const vouched = await stageVouches();

	await stageSiloSeeds();
	await keepExecutables();

	const merging = await mergingIn();
	const oid = await commit({ "fs": fs, "dir": DIR, "message": message, "author": author ?? AUTHOR, ...merging === undefined ? {} : { "parent": [await resolveRef({ "fs": fs, "dir": DIR, "ref": "HEAD" }), merging] } });

	if (merging !== undefined) {
		await fs.promises.unlink(MERGE_HEAD).catch(() => undefined);
	}

	if (vouched) {
		await fs.promises.unlink(`${DIR}/${PENDING_VOUCHES}`).catch(() => undefined);
	}

	return { "oid": oid };
}

export async function commitIndex(message: string): Promise<Committed> {
	return committed(message);
}

export interface LogEntry { "oid": string; "message": string; "author": { "name": string; "email": string; "timestamp": number; "timezoneOffset": number } }

export async function history(depth?: number, path?: string): Promise<LogEntry[]> {
	try {
		return (await log({ "fs": fs, "dir": DIR, ...depth === undefined ? {} : { "depth": depth }, ...path === undefined ? {} : { "filepath": path, "follow": true } })).map(({ oid, "commit": entry }) => ({ "oid": oid, "message": entry.message, "author": entry.author }));
	} catch {
		return [];
	}
}

export async function branches(): Promise<{ "current": string | undefined; "all": string[] }> {
	return { "current": await currentBranch({ "fs": fs, "dir": DIR }) || undefined, "all": await listBranches({ "fs": fs, "dir": DIR }) };
}

export async function unpushed(most = 500): Promise<{ "branch": string; "commits": number }[]> {
	const remotes = await listBranches({ "fs": fs, "dir": DIR, "remote": "origin" }).catch(() => [] as string[]);
	const known = new Set<string>();

	for (const name of remotes.filter((each) => each !== "HEAD")) {
		for (const entry of await log({ "fs": fs, "dir": DIR, "ref": `refs/remotes/origin/${name}`, "depth": most }).catch(() => [])) {
			known.add(entry.oid);
		}
	}

	const counts = [];

	for (const branch of await listBranches({ "fs": fs, "dir": DIR })) {
		const commits = (await log({ "fs": fs, "dir": DIR, "ref": branch, "depth": most }).catch(() => [])).findIndex((entry) => known.has(entry.oid));
		const count = commits === -1 ? (await log({ "fs": fs, "dir": DIR, "ref": branch, "depth": most }).catch(() => [])).length : commits;

		if (count > 0) {
			counts.push({ "branch": branch, "commits": count });
		}
	}

	return counts;
}

export async function createBranch(name: string): Promise<void> {
	await branch({ "fs": fs, "dir": DIR, "ref": name });
}

export async function switchBranch(name: string, create = false): Promise<void> {
	if (create) {
		await branch({ "fs": fs, "dir": DIR, "ref": name, "checkout": true });
	} else {
		await checkout({ "fs": fs, "dir": DIR, "ref": name });
	}
}

export async function githubRemote(remote = "origin"): Promise<string | undefined> {
	const url = await getConfig({ "fs": fs, "dir": DIR, "path": `remote.${remote}.url` }) as string | undefined;
	const repository = /(?:github\.com|\/github\/git)\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/u.exec(url ?? "")?.[1];

	return repository === undefined ? undefined : `https://github.com/${repository}.git`;
}

export interface Pushed { "ref": string; "ok": boolean; "error"?: string }

export async function push(http: HttpClient, url: string, ref?: string, force = false): Promise<Pushed> {
	const branchName = ref ?? (await currentBranch({ "fs": fs, "dir": DIR }) || undefined);

	if (branchName === undefined) {
		throw new Error("HEAD is on no branch: name one to push");
	}

	const result = await gitPush({ "fs": fs, "http": http, "dir": DIR, "url": url, "corsProxy": "", "ref": branchName, "remoteRef": branchName, "force": force });
	const answer = result.refs[`refs/heads/${branchName}`];

	return { "ref": branchName, "ok": result.ok && answer?.ok !== false, ...answer?.error === undefined || answer.error === "" ? {} : { "error": answer.error } };
}

export interface Pulled {
	"ref": string;
	"outcome": "up to date" | "ahead" | "fast-forwarded" | "merged" | "merge conflicts" | "diverged" | "conflicts";
	"from"?: string;
	"to"?: string;
	"files"?: string[];
	"conflicts"?: string[];
}

async function haveRef(branch: string): Promise<string> {
	const tracking = `refs/remotes/origin/${branch}`;

	return await resolveRef({ "fs": fs, "dir": DIR, "ref": tracking }).then(() => tracking, () => branch);
}

export async function pull(http: HttpClient, url: string, ref?: string): Promise<Pulled> {
	const branchName = ref ?? (await currentBranch({ "fs": fs, "dir": DIR }) || undefined);

	if (branchName === undefined) {
		throw new Error("HEAD is on no branch: name one to bring up to date");
	}

	const fetched = await gitFetch({ "fs": fs, "http": http, "dir": DIR, "url": url, "corsProxy": "", "ref": await haveRef(branchName), "remoteRef": branchName, "singleBranch": true, "tags": false });

	if (fetched.fetchHead === null) {
		throw new Error(`the remote has no branch ${branchName}`);
	}

	const forward = await fastForward(branchName, fetched.fetchHead);

	return forward.outcome === "diverged" ? mergeWith(branchName, fetched.fetchHead) : forward;
}

export interface Fetched {
	"ref": string;
	"tip": string;
	"commits": number;
	"shallow": boolean;
	"behind": number;
}

const BEHIND_MOST = 1000;

async function behindBy(tip: string): Promise<number> {
	const head = await resolveRef({ "fs": fs, "dir": DIR, "ref": "HEAD" }).catch(() => undefined);

	if (head === undefined || head === tip) {
		return 0;
	}

	const theirs = await log({ "fs": fs, "dir": DIR, "ref": tip, "depth": BEHIND_MOST }).catch(() => []);
	const at = theirs.findIndex((entry) => entry.oid === head);

	return at === -1 ? theirs.length : at;
}

const ALL = 2_147_483_647;

export async function fetchBranch(http: HttpClient, url: string, ref?: string, deepen?: number): Promise<Fetched> {
	const branchName = ref ?? (await currentBranch({ "fs": fs, "dir": DIR }) || undefined);

	if (branchName === undefined) {
		throw new Error("HEAD is on no branch: name one to fetch");
	}

	const fetched = await gitFetch({ "fs": fs, "http": http, "dir": DIR, "url": url, "corsProxy": "", "ref": await haveRef(branchName), "remoteRef": branchName, "singleBranch": true, "tags": false, ...deepen === undefined ? {} : { "depth": deepen === Infinity ? ALL : deepen, "relative": true } });

	if (fetched.fetchHead === null) {
		throw new Error(`the remote has no branch ${branchName}`);
	}

	return { "ref": branchName, "tip": fetched.fetchHead, "commits": (await history()).length, "shallow": (await shallowEnds()).length > 0, "behind": await behindBy(fetched.fetchHead) };
}

async function changedBetween(from: string, to: string): Promise<{ "path": string; "oid"?: string; "mode"?: number }[]> {
	const changed: { "path": string; "oid"?: string; "mode"?: number }[] = [];

	await walk({
		"fs": fs,
		"dir": DIR,
		"trees": [TREE({ "ref": from }), TREE({ "ref": to })],
		"map": async (path, [ours, theirs]) => {
			const [oursOid, theirsOid] = [await ours?.oid(), await theirs?.oid()];

			if (path === ".") {
				return true;
			}

			if (oursOid === theirsOid && await ours?.mode() === await theirs?.mode()) {
				return null;
			}

			if (await theirs?.type() === "blob") {
				changed.push({ "path": path, "oid": theirsOid, "mode": await theirs?.mode() });
			} else if (await ours?.type() === "blob") {
				changed.push({ "path": path });
			}

			return true;
		}
	});

	return changed;
}

async function changedHere(changed: { "path": string }[]): Promise<string[]> {
	const { staged, unstaged } = await status();
	const here = new Set([...staged, ...unstaged].map((change) => change.path));

	return changed.filter(({ path }) => here.has(path)).map(({ path }) => path);
}

async function writeChanged(changed: { "path": string; "oid"?: string; "mode"?: number }[]): Promise<void> {
	for (const { path, oid, mode } of changed) {
		const full = `${DIR}/${path}`;

		if (oid === undefined) {
			await fs.promises.unlink(full).catch(() => undefined);
			await remove({ "fs": fs, "dir": DIR, "filepath": path });
		} else {
			const { blob } = await readBlob({ "fs": fs, "dir": DIR, "oid": oid });

			await fs.promises.mkdir(full.slice(0, full.lastIndexOf("/")), { "recursive": true });
			await fs.promises.writeFile(full, blob);
			await updateIndex({ "fs": fs, "dir": DIR, "filepath": path, "oid": oid, ...mode === undefined ? {} : { "mode": mode }, "add": true });
		}
	}
}

export async function fastForward(branchName: string, to: string): Promise<Pulled> {
	const from = await resolveRef({ "fs": fs, "dir": DIR, "ref": `refs/heads/${branchName}` });
	const descends = async (oid: string, ancestor: string): Promise<boolean> => isDescendent({ "fs": fs, "dir": DIR, "oid": oid, "ancestor": ancestor, "depth": -1 }).catch(() => false);

	if (from === to) {
		return { "ref": branchName, "outcome": "up to date" };
	}

	if (await descends(from, to)) {
		return { "ref": branchName, "outcome": "ahead", "from": from, "to": to };
	}

	if (!await descends(to, from)) {
		return { "ref": branchName, "outcome": "diverged", "from": from, "to": to };
	}

	const changed = await changedBetween(from, to);
	const conflicts = await changedHere(changed);

	if (conflicts.length > 0) {
		return { "ref": branchName, "outcome": "conflicts", "from": from, "to": to, "conflicts": conflicts };
	}

	await writeChanged(changed);
	await writeRef({ "fs": fs, "dir": DIR, "ref": `refs/heads/${branchName}`, "value": to, "force": true });

	return { "ref": branchName, "outcome": "fast-forwarded", "from": from, "to": to, "files": changed.map(({ path }) => path) };
}

export async function mergingIn(): Promise<string | undefined> {
	return fs.promises.readFile(MERGE_HEAD, "utf8").then((text) => text.trim() || undefined, () => undefined);
}

export async function mergeWith(branchName: string, theirs: string): Promise<Pulled> {
	const from = await resolveRef({ "fs": fs, "dir": DIR, "ref": `refs/heads/${branchName}` });
	const { staged, unstaged } = await status();

	if (staged.length > 0 || unstaged.some((change) => change.status !== "A")) {
		return { "ref": branchName, "outcome": "diverged", "from": from, "to": theirs };
	}

	const conflicts = await changedHere(await changedBetween(from, theirs));

	if (conflicts.length > 0) {
		return { "ref": branchName, "outcome": "conflicts", "from": from, "to": theirs, "conflicts": conflicts };
	}

	const merging = "refs/merging";

	await writeRef({ "fs": fs, "dir": DIR, "ref": merging, "value": theirs, "force": true });

	try {
		const merged = await merge({ "fs": fs, "dir": DIR, "ours": branchName, "theirs": merging, "abortOnConflict": false, "message": `Merge ${theirs.slice(0, 7)} into ${branchName}`, "author": await authorOf().catch(() => undefined) ?? AUTHOR });
		const changed = await changedBetween(from, merged.oid);

		await writeChanged(changed);

		return { "ref": branchName, "outcome": "merged", "from": from, "to": merged.oid, "files": changed.map(({ path }) => path) };
	} catch (error) {
		if (!(error instanceof Errors.MergeConflictError)) {
			throw error;
		}

		await fs.promises.writeFile(MERGE_HEAD, `${theirs}\n`);

		return { "ref": branchName, "outcome": "merge conflicts", "from": from, "to": theirs, "conflicts": error.data.filepaths };
	} finally {
		await deleteRef({ "fs": fs, "dir": DIR, "ref": merging }).catch(() => undefined);
	}
}

export async function abortMerge(): Promise<void> {
	const theirs = await mergingIn();

	if (theirs === undefined) {
		throw new Error("there's no merge to abort");
	}

	const head = await resolveRef({ "fs": fs, "dir": DIR, "ref": "HEAD" });
	const branchName = await currentBranch({ "fs": fs, "dir": DIR });

	for (const { path } of (await changedBetween(theirs, head)).filter(({ oid }) => oid === undefined)) {
		await fs.promises.unlink(`${DIR}/${path}`).catch(() => undefined);
		await remove({ "fs": fs, "dir": DIR, "filepath": path });
	}

	await checkout({ "fs": fs, "dir": DIR, "ref": branchName || "HEAD", "force": true });
	await fs.promises.unlink(MERGE_HEAD).catch(() => undefined);
}

export async function commitAll(message: string): Promise<Committed> {
	await stageAll();

	if ((await status()).staged.length === 0) {
		throw new Error("nothing to commit");
	}

	return committed(message);
}

export interface CommitFile {
	"path": string;
	"content"?: string;
	"deleted"?: boolean;
}

export async function commitSelection(message: string, files: CommitFile[]): Promise<Committed> {
	const { staged, unstaged } = await status();

	for (const path of new Set([...staged, ...unstaged].map((change) => change.path))) {
		try {
			await resetIndex({ "fs": fs, "dir": DIR, "filepath": path });
		} catch { /* nothing to reset */ }
	}

	for (const file of files) {
		if (file.deleted === true) {
			await remove({ "fs": fs, "dir": DIR, "filepath": file.path });
		} else if (file.content !== undefined) {
			const oid = await writeBlob({ "fs": fs, "dir": DIR, "blob": new TextEncoder().encode(file.content) });

			await updateIndex({ "fs": fs, "dir": DIR, "filepath": file.path, "oid": oid, "add": true, "mode": 0o100644 });
		} else {
			await add({ "fs": fs, "dir": DIR, "filepath": file.path });
		}
	}

	return committed(message);
}

export async function headCommit(): Promise<string | undefined> {
	try {
		return await resolveRef({ "fs": fs, "dir": DIR, "ref": "HEAD" });
	} catch {
		return undefined;
	}
}

async function isTracked(path: string): Promise<boolean> {
	try {
		const oid = await resolveRef({ "fs": fs, "dir": DIR, "ref": "HEAD" });

		await readBlob({ "fs": fs, "dir": DIR, "oid": oid, "filepath": path });

		return true;
	} catch {
		return false;
	}
}

export async function discardFile(path: string): Promise<void> {
	const full = DIR + "/" + path;

	if (await isTracked(path)) {
		await fs.promises.writeFile(full, await headContent(path));

		try {
			await resetIndex({ "fs": fs, "dir": DIR, "filepath": path });
		} catch { /* nothing staged */ }
	} else if (fs.existsSync(full)) {
		await fs.promises.unlink(full);
	}
}

export async function setWorking(path: string, content: string): Promise<void> {
	await fs.promises.writeFile(DIR + "/" + path, content);
}

export async function blobOid(content: string): Promise<string> {
	return (await hashBlob({ "object": new TextEncoder().encode(content) })).oid;
}

export async function workingContent(path: string): Promise<string> {
	return fs.existsSync(DIR + "/" + path) ? fs.promises.readFile(DIR + "/" + path, "utf8") : "";
}

export async function blobText(oid: string): Promise<string | undefined> {
	try {
		return new TextDecoder().decode((await readBlob({ "fs": fs, "dir": DIR, "oid": oid })).blob);
	} catch {
		return undefined;
	}
}

export async function headContent(path: string): Promise<string> {
	return await fileAt(path, "HEAD") ?? "";
}

async function oidOf(ref: string): Promise<string> {
	return /^[\da-f]{4,40}$/u.test(ref) ? expandOid({ "fs": fs, "dir": DIR, "oid": ref }).catch(async () => resolveRef({ "fs": fs, "dir": DIR, "ref": ref })) : resolveRef({ "fs": fs, "dir": DIR, "ref": ref });
}

export async function commitOf(ref: string): Promise<{ "oid": string; "time": number } | undefined> {
	try {
		const { oid, commit: made } = await readCommit({ "fs": fs, "dir": DIR, "oid": await oidOf(ref) });

		return { "oid": oid, "time": made.committer.timestamp * 1000 };
	} catch {
		return undefined;
	}
}

export async function treeAt(commit: string, path: string): Promise<{ "name": string; "type": "blob" | "tree" | "commit"; "oid": string }[] | undefined> {
	try {
		const { tree } = await readTree({ "fs": fs, "dir": DIR, "oid": commit, ...path === "" ? {} : { "filepath": path } });

		return tree.map((entry) => ({ "name": entry.path, "type": entry.type, "oid": entry.oid }));
	} catch {
		return undefined;
	}
}

export async function blobBytes(oid: string): Promise<Uint8Array> {
	return (await readBlob({ "fs": fs, "dir": DIR, "oid": oid })).blob;
}

export async function fileAt(path: string, ref: string): Promise<string | undefined> {
	try {
		const oid = await oidOf(ref);
		const { blob } = await readBlob({ "fs": fs, "dir": DIR, "oid": oid, "filepath": path });

		return new TextDecoder().decode(blob);
	} catch {
		return undefined;
	}
}

export async function fetchRef(http: HttpClient, url: string, ref: string): Promise<boolean> {
	const fetched = await gitFetch({ "fs": fs, "http": http, "dir": DIR, "url": url, "corsProxy": "", "ref": ref, "singleBranch": true, "depth": 1, "tags": true });

	return fetched.fetchHead !== null;
}

export async function shallowEnds(): Promise<string[]> {
	try {
		return (await fs.promises.readFile(DIR + "/.git/shallow", "utf8")).split("\n").filter((line) => line.trim() !== "");
	} catch {
		return [];
	}
}

/**
 * What running your program teaches the editor, kept in git (RUNTIME-EVIDENCE.md): when a run ends, its envelope —
 * whose run, where it ran, on what code — is appended to `.silo/runs/<user>.jsonl`, and what it observed is folded into
 * `.silo/evidence/<user>/<environment>/<file>.jsonl`, keyed on BABLR spans. silo decides the shape, the layout and how
 * evidence fades (@brianjenkins94/util/silo/evidence); this gathers the facts only the editor has: the run (runs.ts), the
 * browser it ran in, the repo it ran on, and what the runtimes saw — so far what a debug session observed
 * (`evidence.observed`, from the tsval adapter): its coverage, each statement keyed by the span the BABLR worker picks
 * for it, and what went through its observed sites (values at `?.`, `??`, parameters and returns; each branch's arms),
 * each keyed by the span that is exactly its node — a site without one isn't recorded — and what a preview's pages
 * counted (`evidence.preview`, page-evidence.ts), each module version read against its own source (the dev server's,
 * asked for as soon as a version turns up: `preview.version`), its run found by the window's port. The values
 * themselves stay on this machine (`.silo/local/samples/`). A file BABLR's grammar doesn't take yet gets no evidence; its
 * run is still recorded.
 *
 * Runs in the workbench realm; writes through VS Code's file system, so an open runs file shows each new line.
 */
import type * as vscodeApi from "vscode";
import type { Hub } from "@brianjenkins94/hub";
import type { Environment, RunEnvelope } from "@brianjenkins94/util/silo/evidence";
import type { SiteObservation, StatementCoverage } from "./extensions/worker-pod/debug-protocol";
import type { ModuleEvidence } from "./extensions/worker-pod/page-evidence";
import type { Bablr } from "./bablr";
import type { RunInfo, RunRegistry } from "./runs";
import { createRpcClient, serve } from "@brianjenkins94/hub";
import { envelopeLine, evidencePath, evidenceText, foldBranches, foldReached, foldSamples, foldValues, GITATTRIBUTES, GITIGNORE, parseEvidence, parseSamples, runsPath, samplesPath, samplesText, SILO_DIR, userSlug } from "@brianjenkins94/util/silo/evidence";
import { blobOid, headCommit } from "./git-engine";

const ROOT = "/workspace";

interface UserAgentData { "brands"?: { "brand": string; "version": string }[]; "platform"?: string }

/** The browser this tab runs in, as silo's environment class: engine and major version, OS family, cores, memory. */
function browserClass(): Omit<Environment, "runtime" | "name"> {
	const agent = (navigator as Navigator & { "userAgentData"?: UserAgentData }).userAgentData;
	const ua = navigator.userAgent;
	const chromium = agent?.brands?.find((brand) => brand.brand === "Chromium")?.version ?? /Chrom(?:e|ium)\/(\d+)/u.exec(ua)?.[1];
	const firefox = /Firefox\/(\d+)/u.exec(ua)?.[1];
	const safari = /Version\/(\d+).*Safari/u.exec(ua)?.[1];
	const engine = chromium !== undefined ? `chromium-${chromium}` : firefox !== undefined ? `firefox-${firefox}` : safari !== undefined ? `webkit-${safari}` : "unknown";
	const platform = (agent?.platform ?? navigator.platform ?? "").toLowerCase();
	const os = /android/u.test(ua.toLowerCase()) ? "android" : /iphone|ipad/u.test(ua.toLowerCase()) ? "ios" : platform.startsWith("mac") ? "macos" : platform.startsWith("win") ? "windows" : platform.includes("linux") ? "linux" : "unknown";
	const memory = (navigator as Navigator & { "deviceMemory"?: number }).deviceMemory;

	return { "engine": engine, "os": os, "cores": navigator.hardwareConcurrency, ...memory === undefined ? {} : { "memoryGb": memory } };
}

/** What a run observed of the program it ran: the source that ran, each statement's range in it with its count, and
 *  each observed site that ran. */
interface Coverage { "file": string; "source": string; "statements": StatementCoverage[]; "sites": SiteObservation[] }

/** Each range in `source` as offsets (its line/character positions, counted in UTF-16 code units). */
function offsets(source: string, statements: { "start": [number, number]; "end": [number, number] }[]): { "start": number; "end": number }[] {
	const lineStarts = [0];

	for (let index = source.indexOf("\n"); index !== -1; index = source.indexOf("\n", index + 1)) {
		lineStarts.push(index + 1);
	}

	const at = ([line, character]: [number, number]): number => (lineStarts[line] ?? source.length) + character;

	return statements.map((statement) => ({ "start": at(statement.start), "end": at(statement.end) }));
}

/** Two pages' totals for one module version, added up: its statements (the same list, in the same order: the same
 *  version), and its sites, matched by range — counts summed, kinds summed, samples joined (at most five). */
function mergeModules(a: ModuleEvidence, b: ModuleEvidence): ModuleEvidence {
	const key = (site: SiteObservation): string => `${site.start.join(":")}-${site.end.join(":")}`;
	const sites = new Map(a.sites.map((site) => [key(site), site]));

	for (const site of b.sites) {
		const known = sites.get(key(site));

		if (known === undefined) {
			sites.set(key(site), site);
			continue;
		}

		const tags = { ...known.tags };

		for (const [tag, count] of Object.entries(site.tags ?? {})) {
			tags[tag] = (tags[tag] ?? 0) + count;
		}

		sites.set(key(site), {
			...known,
			...known.seen === undefined ? {} : { "seen": known.seen + (site.seen ?? 0), "nullish": (known.nullish ?? 0) + (site.nullish ?? 0), "tags": tags, "samples": [...new Set([...known.samples ?? [], ...site.samples ?? []])].slice(0, 5) },
			...known.arms === undefined ? {} : { "arms": known.arms.map((count, arm) => count + (site.arms?.[arm] ?? 0)) }
		});
	}

	return { ...a, "statements": a.statements.map((statement, index) => ({ ...statement, "count": statement.count + (b.statements[index]?.count ?? 0) })), "sites": [...sites.values()] };
}

let siloFiles: Promise<void> | undefined;

/**
 * `.silo/`'s own two files, before anything is written into it: `.gitignore` (silo's GITIGNORE — `local/` stays on this
 * machine) and `.gitattributes` (silo's GITATTRIBUTES — its JSONL merges by line). Lines already there are kept. Once a
 * session; profile-files.ts calls it too, since a profile can be the first thing saved there.
 */
export async function ensureSiloFiles(vscode: typeof vscodeApi): Promise<void> {
	siloFiles ??= (async () => {
		for (const [name, wanted] of [[".gitignore", GITIGNORE], [".gitattributes", GITATTRIBUTES]] as const) {
			const uri = vscode.Uri.file(`${ROOT}/${SILO_DIR}/${name}`);
			const existing = await vscode.workspace.fs.readFile(uri).then((bytes) => new TextDecoder().decode(bytes), () => "");
			const missing = wanted.split("\n").filter((line) => line !== "" && !existing.split(/\r?\n/u).includes(line));

			if (missing.length > 0) {
				await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode((existing === "" || existing.endsWith("\n") ? existing : existing + "\n") + missing.join("\n") + "\n"));
			}
		}
	})().catch(() => { siloFiles = undefined; });

	return siloFiles;
}

/** `path` relative to the workspace (the repo root). */
function repoRelative(path: string): string {
	return path.startsWith(ROOT + "/") ? path.slice(ROOT.length + 1) : path === ROOT ? "." : path;
}

export function installEvidence(vscode: typeof vscodeApi, hub: Hub, runs: RunRegistry, bablr: Bablr): void {
	const rpc = createRpcClient(hub);

	// How much a preview's dev server instruments (`silo.evidence.previews`), asked as each preview starts.
	serve(hub, "evidence.level", () => vscode.workspace.getConfiguration("silo.evidence").get<string>("previews") ?? "full");
	// Each run's coverage, until the run ends (the session's coverage comes just before its end): its entry's, and each
	// other of the program's files that ran (MODULES.md).
	const coverage = new Map<string, Coverage[]>();
	const coverageOf = (each: Partial<Coverage>): Coverage[] => (typeof each.file === "string" && typeof each.source === "string" && Array.isArray(each.statements) ? [{ "file": each.file, "source": each.source, "statements": each.statements, "sites": Array.isArray(each.sites) ? each.sites : [] }] : []);

	hub.subscribe("evidence.observed", (data) => {
		const { runId, files, ...rest } = (data ?? {}) as Partial<Coverage> & { "runId"?: unknown; "files"?: unknown };
		const entry = coverageOf(rest);

		if (typeof runId === "string" && entry.length > 0) {
			coverage.set(runId, [...entry, ...(Array.isArray(files) ? files as Partial<Coverage>[] : []).flatMap(coverageOf)]);
		}
	});

	// Each preview run's evidence, until it ends: every page's latest totals (a page reports all it has counted since it
	// loaded), and each module version's source — asked of the dev server as soon as a version turns up, while it's
	// still serving (it can be stopped before the run ends).
	const previews = new Map<string, { "pages": Map<string, ModuleEvidence[]>; "sources": Map<string, Promise<string | undefined>>; "versions": Map<string, string[]> }>();

	hub.subscribe("evidence.preview", (data) => {
		const { window, page, modules } = (data ?? {}) as { "window"?: unknown; "page"?: unknown; "modules"?: unknown };
		const port = Number(/^preview:(\d+)/u.exec(typeof window === "string" ? window : "")?.[1]);
		const run = Number.isNaN(port) ? undefined : runs.runningService((candidate) => candidate.port === port);

		if (run === undefined || typeof page !== "string" || !Array.isArray(modules)) {
			return;
		}

		const preview = previews.get(run.id) ?? { "pages": new Map(), "sources": new Map(), "versions": new Map() };

		previews.set(run.id, preview);
		preview.pages.set(page, modules as ModuleEvidence[]);

		for (const { file, version } of modules as ModuleEvidence[]) {
			if (!preview.sources.has(version)) {
				preview.sources.set(version, rpc.request("preview.version", { "port": port, "oid": version }, { "timeoutMs": 10_000, "waitForResponderMs": 5_000 }).then((answer) => (answer as { "source"?: string } | undefined)?.source, () => undefined));
				preview.versions.set(file, [...preview.versions.get(file) ?? [], version]);
			}
		}
	});

	const uri = (path: string): vscodeApi.Uri => vscode.Uri.file(`${ROOT}/${path}`);
	const read = async (path: string): Promise<Uint8Array | undefined> => {
		try {
			return await vscode.workspace.fs.readFile(uri(path));
		} catch {
			return undefined;
		}
	};
	let user: Promise<string> | undefined;
	// Who you are to git, read once: the repo's own config names you (a slug of your email); `local` until it does.
	const currentUser = async (): Promise<string> => {
		user ??= read(".git/config").then((config) => (config === undefined ? undefined : userSlug(new TextDecoder().decode(config))) ?? "local");

		return user;
	};

	// One write at a time: each appends to the file the last one wrote.
	let writing = Promise.resolve();

	const record = async (run: RunInfo): Promise<void> => {
		const entry = repoRelative(run.entry ?? run.cwd);
		const covered = coverage.get(run.id);
		const preview = previews.get(run.id);

		coverage.delete(run.id);
		previews.delete(run.id);

		const source = run.entry === undefined ? undefined : await read(entry);
		const name = vscode.workspace.getConfiguration("silo").get<string>("machine")?.trim();
		const envelope: RunEnvelope = {
			"type": "run",
			"id": run.id,
			"title": run.title,
			"entry": entry,
			"cwd": repoRelative(run.cwd),
			"startedAt": new Date(run.startedAt).toISOString(),
			"endedAt": new Date(run.endedAt ?? Date.now()).toISOString(),
			"exit": run.exitCode ?? 0,
			...run.state === "stopped" ? { "stopped": true as const } : {},
			"user": await currentUser(),
			"environment": { "runtime": run.runtime ?? "almostnode", ...browserClass(), "name": name === undefined || name === "" ? "default" : name },
			...await headCommit().then((commit) => (commit === undefined ? {} : { "commit": commit })),
			"files": source === undefined ? {} : { [entry]: await blobOid(new TextDecoder().decode(source)) }
		};

		// The code a session ran is the source it was given, whatever the file holds now.
		for (const each of covered ?? []) {
			envelope.files[repoRelative(each.file)] = await blobOid(each.source);
		}

		// A preview ran every version of a module its hot updates brought: the last is the file's; all are listed.
		for (const [file, oids] of preview?.versions ?? []) {
			envelope.files[repoRelative(file)] = oids.at(-1)!;

			if (oids.length > 1) {
				envelope.versions = { ...envelope.versions, [repoRelative(file)]: oids };
			}
		}

		const path = runsPath(envelope.user);
		const before = await read(path) ?? new Uint8Array();

		await ensureSiloFiles(vscode);
		await vscode.workspace.fs.writeFile(uri(path), new Uint8Array([...before, ...new TextEncoder().encode(envelopeLine(envelope))]));

		for (const each of covered ?? []) {
			await recordFile(envelope, repoRelative(each.file), [each]);
		}

		if (preview !== undefined) {
			await recordPreview(envelope, preview);
		}
	};

	/** A preview run's evidence: every page's totals for each module version added up, each version read against its
	 *  own source, each file folded once. A version whose source can't be had (the dev server never said) is left out. */
	const recordPreview = async (envelope: RunEnvelope, preview: NonNullable<ReturnType<typeof previews.get>>): Promise<void> => {
		const byVersion = new Map<string, ModuleEvidence>();

		for (const modules of preview.pages.values()) {
			for (const module of modules) {
				const key = `${module.file}\0${module.version}`;
				const known = byVersion.get(key);

				byVersion.set(key, known === undefined ? module : mergeModules(known, module));
			}
		}

		const byFile = new Map<string, Coverage[]>();

		for (const module of byVersion.values()) {
			const source = await preview.sources.get(module.version);

			if (source !== undefined) {
				byFile.set(module.file, [...byFile.get(module.file) ?? [], { "file": module.file, "source": source, "statements": module.statements, "sites": module.sites }]);
			}
		}

		for (const [file, versions] of byFile) {
			await recordFile(envelope, repoRelative(file), versions);
		}
	};

	/** What a run observed of `file` — in each version of it that ran — keyed on spans and folded, once, into what earlier
	 *  runs in its environment observed of it; its values' samples into this machine's. Code a version didn't change has
	 *  the same spans in every version, so what each saw there adds up. */
	const recordFile = async (envelope: RunEnvelope, file: string, versions: Coverage[]): Promise<void> => {
		const reached: { "span": string; "count": number }[] = [];
		const sites: (SiteObservation & { "span": string })[] = [];

		for (const covered of versions) {
			if (covered.source === "") {
				continue; // BABLR has nothing to parse
			}

			const ids = await bablr.anchors(covered.source, offsets(covered.source, covered.statements));
			const siteIds = await bablr.anchors(covered.source, offsets(covered.source, covered.sites), true);

			if (ids === undefined || siteIds === undefined) {
				continue; // BABLR's grammar doesn't take this version yet
			}

			covered.statements.forEach((statement, index) => {
				if (typeof ids[index] === "string") {
					reached.push({ "span": ids[index], "count": statement.count });
				}
			});
			covered.sites.forEach((site, index) => {
				if (typeof siteIds[index] === "string") {
					sites.push({ ...site, "span": siteIds[index] });
				}
			});
		}

		if (reached.length === 0 && sites.length === 0) {
			return;
		}

		const values = sites.filter((site) => site.site !== "branch").map((site) => ({ "span": site.span, "seen": site.seen ?? 0, "nullish": site.nullish ?? 0, "tags": site.tags ?? {} }));
		const branches = sites.filter((site) => site.site === "branch").map((site) => ({ "span": site.span, "arms": site.arms ?? [] }));
		const path = evidencePath(envelope.user, envelope.environment, file);
		const run = { "id": envelope.id, "at": envelope.endedAt };
		const folded = foldBranches(foldValues(foldReached(parseEvidence(new TextDecoder().decode(await read(path) ?? new Uint8Array())), reached, run), values, run), branches, run);

		await vscode.workspace.fs.writeFile(uri(path), new TextEncoder().encode(evidenceText(folded)));

		// The values themselves, for this machine only — and only for sites the evidence still knows.
		const samples = sites.flatMap((site) => (site.samples === undefined ? [] : [{ "span": site.span, "values": site.samples }]));
		const local = samplesPath(file);
		const known = parseSamples(new TextDecoder().decode(await read(local) ?? new Uint8Array()));

		if (samples.length > 0 || known.length > 0) {
			await vscode.workspace.fs.writeFile(uri(local), new TextEncoder().encode(samplesText(foldSamples(known, samples, new Set(folded.filter((each) => each.kind === "value").map((each) => each.span))))));
		}
	};

	runs.onEnd((run) => {
		writing = writing.then(async () => record(run)).catch(() => { /* evidence never breaks a run */ });
	});
}

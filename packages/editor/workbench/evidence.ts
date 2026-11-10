/**
 * What running your program teaches the editor, kept in git (RUNTIME-EVIDENCE.md): when a run ends, its envelope — whose
 * run, where it ran, on what code — is appended to `.silo/runs/<user>.jsonl`, and what it observed is folded into
 * `.silo/evidence/<user>/<environment>/<file>.jsonl`, keyed on BABLR spans. silo decides the shape, the layout and how
 * evidence fades (@brianjenkins94/util/silo/evidence); this gathers the facts only the editor has: the run (runs.ts), the
 * browser it ran in, the repository it ran on, and what the runtime saw — a debug session's report as it ends
 * (`evidence.observed`, the bridge's, from tsval's `coverage`): each statement's count under the span BABLR picks for it,
 * and what went through each observed site (values at `?.`, `??`, parameters and returns; each branch's arms) under the
 * span that's exactly its node — a site without one isn't recorded. Its capability calls, each with how it was decided
 * (`evidence.effects`), go in its envelope: an answer given at a call is an exception to the policy, on record there. The
 * values themselves stay on this machine
 * (`.silo/local/samples/`). A file BABLR's grammar doesn't take yet gets no evidence; its run is still recorded, saying so.
 *
 * And where a preview's time went, each time it's profiled (profile-times.ts gives each function's time): folded into the
 * file's evidence as it's taken, on the function's span (silo's foldTimes), marked with the run it was taken in, so it's on
 * the code at once rather than when the run ends. Each profile is one in the fading.
 *
 * A live run isn't a run here: it's the editor's, as you type, and would write on every pause.
 *
 * Runs in the workbench realm; writes through VS Code's file system, so an open runs file shows each new line.
 */
import type { Effect, LoadedPackage, SiteObservation, StatementCoverage } from "@brianjenkins94/editor-api";
import type { ModuleEvidence } from "@brianjenkins94/editor-api/recorded";
import type { Hub } from "@brianjenkins94/hub";
import type { Observed } from "@brianjenkins94/observability";
import type { Environment, RunEnvelope } from "@brianjenkins94/util/silo/evidence";
import type * as vscodeApi from "vscode";
import type { RunInfo } from "../shared/runs";
import type { Bablr } from "./bablr";
import type { RunRegistry } from "./runs";
import { createRpcClient, serve } from "@brianjenkins94/hub";
import { envelopeLine, evidencePath, evidenceText, foldBranches, foldReached, foldSamples, foldTimes, foldValues, parseEvidence, parseSamples, ranPackages, samplesText, userSlug } from "@brianjenkins94/util/silo/evidence";
import { GITATTRIBUTES, GITIGNORE, runsPath, samplesPath, SILO_DIR, withLines } from "@brianjenkins94/util/silo/layout";
import { blobOid, headCommit } from "./git-engine";

const ROOT = "/workspace";

/** How long after a preview's server stops its pages' last reports still count (they come as their windows close). */
const LAST_REPORT_MS = 3000;

/** One function's time in a profile of a file: its span (BABLR's, the function's node), its own ms, with what it called,
 *  and its callers and callees by name, each by its ms. */
export interface FunctionTime { "span": string; "selfMs": number; "totalMs": number; "callers": Record<string, number>; "callees": Record<string, number> }

/** A profile of one file: the source it was read against, how long it sampled, and each function's time. */
export interface FileTimes { "source": string; "profiledMs": number; "functions": FunctionTime[] }

/** What evidence takes from elsewhere in the workbench: a profile's times, of a file (a workspace path), taken in a run. */
export interface EvidenceIntake { "times": (runId: string, file: string, times: FileTimes) => void }

interface UserAgentData { "brands"?: { "brand": string; "version": string }[]; "platform"?: string }

/** The engine and its major version, from the first of them the browser names. */
function engineOf(chromium: string | undefined, firefox: string | undefined, safari: string | undefined): string {
	if (chromium !== undefined) {
		return `chromium-${chromium}`;
	}

	if (firefox !== undefined) {
		return `firefox-${firefox}`;
	}

	return safari === undefined
		? "unknown"
		: `webkit-${safari}`;
}

/** The OS family, from the user agent and the platform (both lowercased). */
function osOf(ua: string, platform: string): string {
	if (ua.includes("android")) {
		return "android";
	}

	if (/iphone|ipad/u.test(ua)) {
		return "ios";
	}

	if (platform.startsWith("mac")) {
		return "macos";
	}

	if (platform.startsWith("win")) {
		return "windows";
	}

	return platform.includes("linux")
		? "linux"
		: "unknown";
}

/** The browser this tab runs in, as silo's environment class: engine and major version, OS family, cores, memory. */
function browserClass(): Omit<Environment, "runtime" | "name"> {
	const agent = (navigator as Navigator & { "userAgentData"?: UserAgentData }).userAgentData;
	const ua = navigator.userAgent;
	const chromium = agent?.brands?.find((brand) => brand.brand === "Chromium")?.version ?? /Chrom(?:e|ium)\/(\d+)/u.exec(ua)?.[1];
	const firefox = /Firefox\/(\d+)/u.exec(ua)?.[1];
	const safari = /Version\/(\d+)(?:\D.*)?Safari/u.exec(ua)?.[1];
	const memory = (navigator as Navigator & { "deviceMemory"?: number }).deviceMemory;

	return {
		"engine": engineOf(chromium, firefox, safari),
		"os": osOf(ua.toLowerCase(), (agent?.platform ?? navigator.platform).toLowerCase()),
		"cores": navigator.hardwareConcurrency,
		...memory === undefined
			? {}
			: { "memoryGb": memory }
	};
}

/** What a run observed of one file: the text that ran, each statement that could run with its count, each observed
 *  site that ran. */
interface Coverage { "file": string; "source": string; "statements": StatementCoverage[]; "sites": SiteObservation[] }

/** Each range in `source` as offsets (its line/character positions, counted in UTF-16 code units). */
export function offsets(source: string, ranges: { "start": [number, number]; "end": [number, number] }[]): { "start": number; "end": number }[] {
	const lineStarts = [0];

	for (let index = source.indexOf("\n"); index !== -1; index = source.indexOf("\n", index + 1)) {
		lineStarts.push(index + 1);
	}

	const at = ([line, character]: [number, number]): number => (lineStarts[line] ?? source.length) + character;

	return ranges.map((range) => ({
		"start": at(range.start),
		"end": at(range.end)
	}));
}

/** Each range's span among `spans` whose range is exactly its own, or undefined. Several spans can have one range (a
 *  BinaryExpression in a LogicExpression in an Expression), innermost first: the innermost without an ordinal is the
 *  node itself, and its id doesn't shift when the same code turns up earlier in the file. A statement's range from
 *  TypeScript takes its `;`; BABLR's doesn't. */
export function exactSpans(source: string, spans: { "id": string; "start": number; "end": number }[], ranges: { "start": number; "end": number }[]): (string | undefined)[] {
	const byRange = new Map<string, { "id": string }[]>();

	for (const span of spans) {
		byRange.set(`${String(span.start)}:${String(span.end)}`, [
			...byRange.get(`${String(span.start)}:${String(span.end)}`) ?? [],
			span
		]);
	}

	return ranges.map(({ start, end }) => {
		const found = byRange.get(`${String(start)}:${String(end)}`) ?? (source[end - 1] === ";"
			? byRange.get(`${String(start)}:${String(end - 1)}`)
			: undefined);

		return (found?.find((span) => !span.id.includes("#")) ?? found?.[0])?.id;
	});
}

/** Two pages' totals for one module version, added up: its statements (the same list, in the same order: the same
 *  version), and its sites, matched by range — counts summed, kinds summed, samples joined (at most five). */
export function mergeModules(first: ModuleEvidence, second: ModuleEvidence): ModuleEvidence {
	const key = (site: SiteObservation): string => `${site.start.join(":")}-${site.end.join(":")}`;
	const sites = new Map(first.sites.map((site) => [
		key(site),
		site
	]));

	for (const site of second.sites) {
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
			...known.seen === undefined
				? {}
				: {
						"seen": known.seen + (site.seen ?? 0),
						"nullish": (known.nullish ?? 0) + (site.nullish ?? 0),
						"tags": tags,
						"samples": [
							...new Set([
								...known.samples ?? [],
								...site.samples ?? []
							])
						].slice(0, 5)
					},
			...known.arms === undefined
				? {}
				: {
						"arms": known.arms.map((count, arm) => count + (site.arms?.[arm] ?? 0))
					}
		});
	}

	return {
		...first,
		"statements": first.statements.map((statement, index) => ({ ...statement, "count": statement.count + (second.statements[index]?.count ?? 0) })),
		"sites": [
			...sites.values()
		]
	};
}

/** `.silo/`'s own two files before anything's written into it: `.gitignore` (`/local/` stays on this machine) and
 *  `.gitattributes` (its JSONL merges by line). Lines already there are kept. */
async function ensureSiloFiles(vscode: typeof vscodeApi): Promise<void> {
	for (const [name, wanted] of [
		[".gitignore", GITIGNORE],
		[".gitattributes", GITATTRIBUTES]
	] as const) {
		const uri = vscode.Uri.file(`${ROOT}/${SILO_DIR}/${name}`);
		const existing = await Promise.resolve(vscode.workspace.fs.readFile(uri)).then((bytes) => new TextDecoder().decode(bytes), () => "");
		const updated = withLines(existing, wanted);

		if (updated !== undefined) {
			await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(updated));
		}
	}
}

/** `path` relative to the workspace (the repository's root). */
function repoRelative(path: string): string {
	if (path.startsWith(ROOT + "/")) {
		return path.slice(ROOT.length + 1);
	}

	return path === ROOT
		? "."
		: path;
}

export function installEvidence(vscode: typeof vscodeApi, hub: Hub, runs: RunRegistry, bablr: Bablr, log: Observed["log"]): EvidenceIntake {
	// Each run's report, until the run ends (the session's coverage comes just before its end): its entry's, and each other
	// of the program's files that ran (packages/tsval/README.md, *Modules*); and the packages whose code it ran.
	const reports = new Map<string, Coverage[]>();
	const packages = new Map<string, LoadedPackage[]>();
	const coverageOf = (each: Partial<Coverage>): Coverage[] => (typeof each.file === "string" && typeof each.source === "string" && Array.isArray(each.statements)
		? [
				{
					"file": each.file,
					"source": each.source,
					"statements": each.statements,
					"sites": Array.isArray(each.sites)
						? each.sites
						: []
				}
			]
		: []);

	hub.subscribe("evidence.observed", (data) => {
		const { runId, files, "packages": loaded, ...rest } = (data ?? {}) as Partial<Coverage> & { "runId"?: unknown; "files"?: unknown; "packages"?: unknown };
		const entry = coverageOf(rest);

		if (typeof runId === "string" && entry.length > 0) {
			reports.set(runId, [
				...entry,
				...(Array.isArray(files)
					? files as Partial<Coverage>[]
					: []).flatMap(coverageOf)
			]);
		}

		if (typeof runId === "string" && Array.isArray(loaded)) {
			packages.set(runId, loaded as LoadedPackage[]);
		}
	});

	// Each run's capability calls as it last told them (each telling all of them so far), until it ends.
	const effectsOf = new Map<string, Effect[]>();

	hub.subscribe("evidence.effects", (data) => {
		const { runId, effects } = (data ?? {}) as { "runId"?: unknown; "effects"?: unknown };

		if (typeof runId === "string" && Array.isArray(effects)) {
			effectsOf.set(runId, effects as Effect[]);
		}
	});

	// How much of a preview's code its dev server instruments (`silo.evidence.previews`), asked as each starts.
	serve(hub, "evidence.level", () => vscode.workspace.getConfiguration("silo.evidence").get<string>("previews") ?? "full");

	// Each preview run's evidence, until it ends: every page's latest totals (a page reports all it has counted since it
	// loaded), and each module version's source, asked of its dev server as soon as the version turns up, while it's
	// still serving (it's stopped before the run ends); and the packages its pages loaded, by name@version (esm.sh's).
	const rpc = createRpcClient(hub);
	const previews = new Map<string, { "pages": Map<string, ModuleEvidence[]>; "sources": Map<string, Promise<string | undefined>>; "versions": Map<string, string[]>; "packages": Set<string> }>();

	hub.subscribe("evidence.preview", (data) => {
		const { window, page, modules, "packages": loaded } = (data ?? {}) as { "window"?: unknown; "page"?: unknown; "modules"?: unknown; "packages"?: unknown };
		const port = Number(/^preview:(\d+)/u.exec(typeof window === "string"
			? window
			: "")?.[1]);
		// (its server's run, or one that's just ended: a page's last report comes as its window closes, after its server)
		const run = Number.isNaN(port)
			? undefined
			: runs.runningService((candidate) => candidate.port === port) ?? runs.list().find((candidate) => candidate.port === port && candidate.endedAt !== undefined && Date.now() - candidate.endedAt < LAST_REPORT_MS);

		if (run === undefined || typeof page !== "string" || !Array.isArray(modules)) {
			return;
		}

		const preview = previews.get(run.id) ?? {
			"pages": new Map(),
			"sources": new Map(),
			"versions": new Map(),
			"packages": new Set()
		};

		previews.set(run.id, preview);
		preview.pages.set(page, modules as ModuleEvidence[]);

		for (const each of Array.isArray(loaded)
			? loaded
			: []) {
			if (typeof each === "string") {
				preview.packages.add(each);
			}
		}

		for (const { file, version } of modules as ModuleEvidence[]) {
			if (!preview.sources.has(version)) {
				preview.sources.set(version, rpc.request("preview.version", { "port": port, "oid": version }, { "timeoutMs": 10_000, "waitForResponderMs": 5_000 }).then((answer) => (answer as { "source"?: string } | undefined)?.source, () => undefined));
				preview.versions.set(file, [
					...preview.versions.get(file) ?? [],
					version
				]);
			}
		}
	});

	/** A preview run's evidence as each file's versions: every page's totals for a version added up, each read against
	 *  its own source. A version whose source can't be had (the dev server never said) is left out. */
	const previewCoverage = async (preview: NonNullable<ReturnType<typeof previews.get>>): Promise<Coverage[]> => {
		const byVersion = new Map<string, ModuleEvidence>();

		for (const modules of preview.pages.values()) {
			for (const module of modules) {
				const key = `${module.file}\0${module.version}`;
				const known = byVersion.get(key);

				byVersion.set(key, known === undefined
					? module
					: mergeModules(known, module));
			}
		}

		const covered: Coverage[] = [];

		for (const module of byVersion.values()) {
			const source = await preview.sources.get(module.version);

			if (source !== undefined) {
				covered.push({
					"file": module.file,
					"source": source,
					"statements": module.statements,
					"sites": module.sites
				});
			}
		}

		return covered;
	};

	const uri = (path: string): vscodeApi.Uri => vscode.Uri.file(`${ROOT}/${path}`);
	const read = async (path: string): Promise<Uint8Array | undefined> => Promise.resolve(vscode.workspace.fs.readFile(uri(path))).catch(() => undefined);
	const text = async (path: string): Promise<string> => new TextDecoder().decode(await read(path) ?? new Uint8Array());

	// Who you are to git: the repository's own config names you (a slug of your email); `local` until it does.
	let user: string | undefined;
	const currentUser = async (): Promise<string> => {
		user ??= userSlug(await text(".git/config"));

		return user ?? "local";
	};

	/** What a run observed of `file`, keyed on spans and folded into what earlier runs in its environment observed of it;
	 *  its values' samples into this machine's. */
	const recordFile = async (envelope: RunEnvelope, file: string, versions: Coverage[]): Promise<{ "statements": number; "sites": number }> => {
		const reached: { "span": string; "count": number }[] = [];
		const sites: (SiteObservation & { "span": string })[] = [];

		// (each version a preview's hot updates brought, read against its own text: code a version didn't change has the
		// same spans in every one, so what each saw there adds up, and the file's folded once, as one run)
		for (const covered of versions.filter((version) => version.source !== "")) {
			const refer = await bablr.refer(covered.source, file, offsets(covered.source, covered.statements));
			const spans = covered.sites.length === 0 || refer.unparsable !== undefined
				? {}
				: await bablr.spans(covered.source);
			const unparsable = refer.unparsable ?? spans.unparsable;

			if (unparsable !== undefined) {
				// What ran here is lost: said in the envelope, so the run's record says so (silo coverage reports it).
				envelope.unparsed = { ...envelope.unparsed, [file]: unparsable };
				continue;
			}

			const siteIds = exactSpans(covered.source, spans.spans ?? [], offsets(covered.source, covered.sites));

			covered.statements.forEach((statement, index) => {
				const span = refer.refs?.[index]?.span;

				if (span !== undefined) {
					reached.push({ "span": span, "count": statement.count });
				}
			});
			covered.sites.forEach((site, index) => {
				if (siteIds[index] !== undefined) {
					sites.push({ ...site, "span": siteIds[index] });
				}
			});
		}

		if (reached.length === 0 && sites.length === 0) {
			return { "statements": 0, "sites": 0 };
		}

		const values = sites.filter((site) => site.site !== "branch").map((site) => ({
			"span": site.span,
			"seen": site.seen ?? 0,
			"nullish": site.nullish ?? 0,
			"tags": site.tags ?? {}
		}));
		const branches = sites.filter((site) => site.site === "branch").map((site) => ({ "span": site.span, "arms": site.arms ?? [] }));
		const path = evidencePath(envelope.user, envelope.environment, file);
		const run = { "id": envelope.id, "at": envelope.endedAt };
		const folded = foldBranches(foldValues(foldReached(parseEvidence(await text(path)), reached, run), values, run), branches, run);

		await vscode.workspace.fs.writeFile(uri(path), new TextEncoder().encode(evidenceText(folded)));

		// The values themselves, for this machine only, and only for sites the evidence still knows.
		const samples = sites.flatMap((site) => (site.samples === undefined
			? []
			: [
					{ "span": site.span, "values": site.samples }
				]));
		const local = samplesPath(file);
		const known = parseSamples(await text(local));

		if (samples.length > 0 || known.length > 0) {
			await vscode.workspace.fs.writeFile(uri(local), new TextEncoder().encode(samplesText(foldSamples(known, samples, new Set(folded.filter((each) => each.kind === "value").map((each) => each.span))))));
		}

		return { "statements": reached.length, "sites": sites.length };
	};

	/** The packages a run ran, by name@version, each with its install's integrity from its project's package-lock.json
	 *  (the folder its node_modules is in: an app in the workspace has its own). */
	const packagesOf = async (loaded: LoadedPackage[]): Promise<NonNullable<RunEnvelope["packages"]>> => {
		const byProject = new Map<string, LoadedPackage[]>();

		for (const { name, version, dir } of loaded) {
			const relative = repoRelative(dir);
			const at = relative.indexOf("node_modules/");

			if (at !== -1) {
				byProject.set(relative.slice(0, at), [
					...byProject.get(relative.slice(0, at)) ?? [],
					{
						"name": name,
						...version === undefined
							? {}
							: { "version": version },
						"dir": relative.slice(at)
					}
				]);
			}
		}

		const ran: NonNullable<RunEnvelope["packages"]> = {};

		for (const [project, installed] of byProject) {
			const lock = await read(project + "package-lock.json");

			Object.assign(ran, ranPackages(installed, lock === undefined
				? undefined
				: new TextDecoder().decode(lock)));
		}

		return ran;
	};

	/** A profile's times of `file`, folded into its evidence on each function's span. */
	const recordTimes = async (taken: RunEnvelope, file: string, times: FileTimes): Promise<number> => {
		const reports = times.functions.map((each) => ({ "span": each.span, "selfMs": each.selfMs, "totalMs": each.totalMs, "profiledMs": times.profiledMs, "callers": each.callers, "callees": each.callees }));

		if (reports.length > 0) {
			const path = evidencePath(taken.user, taken.environment, file);

			await vscode.workspace.fs.writeFile(uri(path), new TextEncoder().encode(evidenceText(foldTimes(parseEvidence(await text(path)), reports, { "id": taken.id, "at": taken.endedAt }))));
		}

		return reports.length;
	};

	/** The environment a run here ran in: its runtime, this browser, and this machine's name (`silo.machine`). */
	const environmentOf = (runtime: string): RunEnvelope["environment"] => {
		const name = vscode.workspace.getConfiguration("silo").get<string>("machine")?.trim();

		return {
			"runtime": runtime,
			...browserClass(),
			"name": name === undefined || name === ""
				? "default"
				: name
		};
	};

	const record = async (run: RunInfo, covered: Coverage[], loaded: LoadedPackage[], versions: Record<string, string[]> = {}, pagePackages: string[] = []): Promise<void> => log.span("editor.workbench.evidence.record", { "op": run.runtime ?? "tsval", "count": covered.length }, async (span) => {
		const entry = repoRelative(run.entry ?? run.cwd);
		const envelope: RunEnvelope = {
			"type": "run",
			"id": run.id,
			"title": run.title,
			"entry": entry,
			"cwd": repoRelative(run.cwd),
			"startedAt": new Date(run.startedAt).toISOString(),
			"endedAt": new Date(run.endedAt ?? Date.now()).toISOString(),
			"exit": run.exitCode ?? 0,
			...run.state === "stopped"
				? { "stopped": true as const }
				: {},
			"user": await currentUser(),
			"environment": environmentOf(run.runtime ?? "tsval"),
			...await headCommit().then((commit) => (commit === undefined
				? {}
				: { "commit": commit })),
			// (the code a session ran is the source it was given, whatever the file holds now)
			"files": Object.fromEntries(await Promise.all(covered.map(async (each) => [
				repoRelative(each.file),
				await blobOid(each.source)
			] as const)))
		};

		// (a preview ran every version of a module its hot updates brought: the last is the file's, all are listed; and its
		// pages' packages are by name@version alone, as esm.sh served them)
		for (const [file, oids] of Object.entries(versions)) {
			envelope.files[repoRelative(file)] = oids.at(-1)!;

			if (oids.length > 1) {
				envelope.versions = { ...envelope.versions, [repoRelative(file)]: oids };
			}
		}

		const effects = effectsOf.get(run.id) ?? [];

		effectsOf.delete(run.id);

		if (effects.length > 0) {
			envelope.effects = effects;
		}

		const ran = {
			...await packagesOf(loaded),
			...Object.fromEntries(pagePackages.map((each) => [each, {}]))
		};

		if (Object.keys(ran).length > 0) {
			envelope.packages = ran;
		}

		await ensureSiloFiles(vscode);

		let statements = 0;
		let sites = 0;

		const byFile = new Map<string, Coverage[]>();

		for (const each of covered) {
			byFile.set(repoRelative(each.file), [
				...byFile.get(repoRelative(each.file)) ?? [],
				each
			]);
		}

		for (const [file, versions] of byFile) {
			const kept = await recordFile(envelope, file, versions);

			statements += kept.statements;
			sites += kept.sites;
		}

		// The envelope last: a run's line in runs/ means what it observed is written, so a commit that has the one has the
		// other (coverage over time reads them commit by commit).
		const path = runsPath(envelope.user);
		const before = await read(path) ?? new Uint8Array();

		await vscode.workspace.fs.writeFile(uri(path), new Uint8Array([
			...before,
			...new TextEncoder().encode(envelopeLine(envelope))
		]));
		span.end({ "statements": statements, "sites": sites, "files": covered.length });
	});

	// One write at a time: each appends to the file the last one wrote.
	let writing = Promise.resolve();

	runs.onEnd((run) => {
		// (a server's run: what its pages say as their windows close counts, so it's recorded once they've had the time)
		if (run.port !== undefined && !reports.has(run.id)) {
			hub.publish("evidence.flush", { "port": run.port });
			setTimeout(() => {
				ended(run);
			}, LAST_REPORT_MS);

			return;
		}

		ended(run);
	});

	function ended(run: RunInfo): void {
		const covered = reports.get(run.id);
		const preview = previews.get(run.id);
		const loaded = packages.get(run.id) ?? [];

		reports.delete(run.id);
		previews.delete(run.id);
		packages.delete(run.id);

		// (a run that told no evidence — a terminal's task, a dev server no page of which ran instrumented code — isn't recorded)
		if (covered !== undefined) {
			writing = writing.then(async () => record(run, covered, loaded)).catch(() => { /* evidence never breaks a run */ });
		} else if (preview !== undefined) {
			writing = writing.then(async () => record(run, await previewCoverage(preview), [], Object.fromEntries(preview.versions), [...preview.packages])).catch(() => { /* evidence never breaks a run */ });
		} else {
			effectsOf.delete(run.id);
		}
	}

	return {
		// (in turn with the runs' own writes: the same files)
		"times": (runId, file, times) => {
			writing = writing.then(async () => log.span("editor.workbench.evidence.time", { "path": repoRelative(file), "count": times.functions.length }, async (span) => {
				const run = runs.list().find((each) => each.id === runId);
				const taken = { "id": runId, "endedAt": new Date().toISOString(), "user": await currentUser(), "environment": environmentOf(run?.runtime ?? "browser") } as RunEnvelope;

				await ensureSiloFiles(vscode);
				span.end({ "functions": await recordTimes(taken, repoRelative(file), times) });
			})).catch(() => { /* evidence never breaks a run */ });
		}
	};
}

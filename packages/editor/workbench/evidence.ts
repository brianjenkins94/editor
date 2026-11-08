/**
 * What running your program teaches the editor, kept in git (RUNTIME-EVIDENCE.md): when a run ends, its envelope — whose
 * run, where it ran, on what code — is appended to `.silo/runs/<user>.jsonl`, and what it observed is folded into
 * `.silo/evidence/<user>/<environment>/<file>.jsonl`, keyed on BABLR spans. silo decides the shape, the layout and how
 * evidence fades (@brianjenkins94/util/silo/evidence); this gathers the facts only the editor has: the run (runs.ts), the
 * browser it ran in, the repository it ran on, and what the runtime saw — a debug session's report as it ends
 * (`evidence.observed`, the bridge's, from tsval's `coverage`): each statement's count under the span BABLR picks for it,
 * and what went through each observed site (values at `?.`, `??`, parameters and returns; each branch's arms) under the
 * span that's exactly its node — a site without one isn't recorded. The values themselves stay on this machine
 * (`.silo/local/samples/`). A file BABLR's grammar doesn't take yet gets no evidence; its run is still recorded, saying so.
 *
 * A live run isn't a run here: it's the editor's, as you type, and would write on every pause.
 *
 * Runs in the workbench realm; writes through VS Code's file system, so an open runs file shows each new line.
 */
import type { LoadedPackage, SiteObservation, StatementCoverage } from "@brianjenkins94/editor-api";
import type { Hub } from "@brianjenkins94/hub";
import type { Observed } from "@brianjenkins94/observability";
import type { Environment, RunEnvelope } from "@brianjenkins94/util/silo/evidence";
import type * as vscodeApi from "vscode";
import type { RunInfo } from "../shared/runs";
import type { Bablr } from "./bablr";
import type { RunRegistry } from "./runs";
import { envelopeLine, evidencePath, evidenceText, foldBranches, foldReached, foldSamples, foldValues, parseEvidence, parseSamples, ranPackages, samplesText, userSlug } from "@brianjenkins94/util/silo/evidence";
import { GITATTRIBUTES, GITIGNORE, runsPath, samplesPath, SILO_DIR, withLines } from "@brianjenkins94/util/silo/layout";
import { blobOid, headCommit } from "./git-engine";

const ROOT = "/workspace";

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

export function installEvidence(vscode: typeof vscodeApi, hub: Hub, runs: RunRegistry, bablr: Bablr, log: Observed["log"]): void {
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
	const recordFile = async (envelope: RunEnvelope, file: string, covered: Coverage): Promise<{ "statements": number; "sites": number }> => {
		if (covered.source === "") {
			return { "statements": 0, "sites": 0 };
		}

		const statementRanges = offsets(covered.source, covered.statements);
		const refer = await bablr.refer(covered.source, file, statementRanges);
		const spans = covered.sites.length === 0 || refer.unparsable !== undefined
			? {}
			: await bablr.spans(covered.source);
		const unparsable = refer.unparsable ?? spans.unparsable;

		if (unparsable !== undefined) {
			// What ran here is lost: said in the envelope, so the run's record says so (silo coverage reports it).
			envelope.unparsed = { ...envelope.unparsed, [file]: unparsable };

			return { "statements": 0, "sites": 0 };
		}

		const siteIds = exactSpans(covered.source, spans.spans ?? [], offsets(covered.source, covered.sites));
		const reached = covered.statements.flatMap((statement, index) => {
			const span = refer.refs?.[index]?.span;

			return span === undefined
				? []
				: [
						{ "span": span, "count": statement.count }
					];
		});
		const sites = covered.sites.flatMap((site, index) => (siteIds[index] === undefined
			? []
			: [
					{ ...site, "span": siteIds[index] }
				]));

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

	const record = async (run: RunInfo, covered: Coverage[], loaded: LoadedPackage[]): Promise<void> => log.span("editor.workbench.evidence.record", { "op": run.runtime ?? "tsval", "count": covered.length }, async (span) => {
		const entry = repoRelative(run.entry ?? run.cwd);
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
			...run.state === "stopped"
				? { "stopped": true as const }
				: {},
			"user": await currentUser(),
			"environment": {
				"runtime": run.runtime ?? "tsval",
				...browserClass(),
				"name": name === undefined || name === ""
					? "default"
					: name
			},
			...await headCommit().then((commit) => (commit === undefined
				? {}
				: { "commit": commit })),
			// (the code a session ran is the source it was given, whatever the file holds now)
			"files": Object.fromEntries(await Promise.all(covered.map(async (each) => [
				repoRelative(each.file),
				await blobOid(each.source)
			] as const)))
		};
		const ran = await packagesOf(loaded);

		if (Object.keys(ran).length > 0) {
			envelope.packages = ran;
		}

		await ensureSiloFiles(vscode);

		let statements = 0;
		let sites = 0;

		for (const each of covered) {
			const kept = await recordFile(envelope, repoRelative(each.file), each);

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
		const covered = reports.get(run.id);
		const loaded = packages.get(run.id) ?? [];

		reports.delete(run.id);
		packages.delete(run.id);

		// (a run that told no evidence — a terminal's task, a dev server — isn't the debugger's to record)
		if (covered !== undefined) {
			writing = writing.then(async () => record(run, covered, loaded)).catch(() => { /* evidence never breaks a run */ });
		}
	});
}

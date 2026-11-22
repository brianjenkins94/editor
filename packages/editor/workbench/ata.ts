import type { Logger } from "@brianjenkins94/util/logger";
import type * as vscode from "vscode";
import { REFS_DIR } from "@brianjenkins94/editor-api/git";
import { waitFor } from "./readiness";
import { aliases, installedLocally } from "./versions";

const RELEVANT = /\.(?:tsx?|jsx?|mts|cts)$/u;
const DEBOUNCE_MS = 800;
const PINS_MS = 30_000;
const MAX_NETWORK = 400;
const DECL = /\.d\.[mc]?ts$/u;

interface MetaNode { "type"?: string; "path": string; "files"?: MetaNode[] }

const SPECIFIER = String.raw`(?<![\w$."'-])(?:from|import|require)\s*(?:\(\s*)?["']([^"'\s]+)["']`;

export function importedPackages(source: string): string[] {
	const roots = new Set<string>();

	for (const match of source.matchAll(new RegExp(SPECIFIER, "gu"))) {
		const pkg = match[1].startsWith("node:") ? "@types/node" : packageRootOf(match[1]);

		if (pkg !== undefined) {
			roots.add(pkg);
		}
	}

	return [...roots];
}

export function importedSubpaths(source: string): [string, string][] {
	const found = new Map<string, [string, string]>();

	for (const match of source.matchAll(new RegExp(SPECIFIER, "gu"))) {
		const pkg = packageRootOf(match[1]);

		if (pkg !== undefined && match[1].length > pkg.length + 1) {
			found.set(match[1], [pkg, match[1].slice(pkg.length + 1)]);
		}
	}

	return [...found.values()];
}

export function exportedTypes(exportsField: unknown, subpath: string): string | undefined {
	if (exportsField === null || typeof exportsField !== "object") {
		return undefined;
	}

	const wanted = "./" + subpath;

	for (const [key, node] of Object.entries(exportsField as Record<string, unknown>)) {
		const star = key.indexOf("*");
		const [before, after] = star === -1 ? [key, ""] : [key.slice(0, star), key.slice(star + 1)];
		const matches = star === -1 ? wanted === key : wanted.startsWith(before) && wanted.endsWith(after) && wanted.length >= key.length - 1;
		const types = matches ? pickTypes(node) : undefined;

		if (types !== undefined) {
			return types.replace("*", wanted.slice(before.length, wanted.length - after.length));
		}
	}

	return undefined;
}

function versionOf(packageJson: string | undefined): string | undefined {
	try {
		const { version } = JSON.parse(packageJson ?? "") as { "version"?: unknown };

		return typeof version === "string" ? version : undefined;
	} catch {
		return undefined;
	}
}

function parseJsonc(text: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//gu, (_, string: string | undefined) => string ?? "").replace(/,(\s*[}\]])/gu, "$1")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function extendsTargets(tsconfig: Record<string, unknown> | undefined): [string, string][] {
	const value = tsconfig?.["extends"];

	return (Array.isArray(value) ? value : [value]).flatMap((spec) => {
		const pkg = typeof spec === "string" ? packageRootOf(spec) : undefined;

		return pkg === undefined ? [] : [[pkg, (spec as string).slice(pkg.length + 1) || "tsconfig.json"] as [string, string]];
	});
}

function packageRootOf(spec: string): string | undefined {
	if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:") || spec.startsWith("#")) {
		return undefined; // relative, absolute, a builtin, or a package's own `imports` alias — not a package
	}

	const parts = spec.split("/");
	const pkg = (parts[0]?.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1)).join("/");

	return pkg !== "" && !(pkg.startsWith("@") && !pkg.includes("/")) ? pkg : undefined;
}

function typesCounterpart(pkg: string): string {
	return pkg.startsWith("@") ? "@types/" + pkg.slice(1).replace("/", "__") : "@types/" + pkg;
}

function typesEntry(meta: Record<string, unknown>): string | undefined {
	const classic = meta["types"] ?? meta["typings"];

	if (typeof classic === "string") {
		return classic;
	}

	const exportsField = meta["exports"];

	return pickTypes(typeof exportsField === "string" ? exportsField : (exportsField as Record<string, unknown> | undefined)?.["."]) ?? declarationBeside(meta["main"]);
}

function declarationBeside(js: unknown): string | undefined {
	return typeof js === "string" && (/\.[mc]?js$/u).test(js) ? js.replace(/\.([mc]?)js$/u, ".d.$1ts") : undefined;
}

function subpathTypes(meta: Record<string, unknown>): string[] {
	const exportsField = meta["exports"];

	if (exportsField === null || typeof exportsField !== "object") {
		return [];
	}

	const out: string[] = [];

	for (const [subpath, node] of Object.entries(exportsField as Record<string, unknown>)) {
		if (subpath.startsWith("./") && !subpath.includes("*") && subpath !== "../package.json") {
			const types = pickTypes(node);

			if (types !== undefined) {
				out.push(types);
			}
		}
	}

	return out;
}

function pickTypes(node: unknown): string | undefined {
	if (node === null || typeof node !== "object") {
		return declarationBeside(node); // a string here is the JS entry: its types sit beside it, if anywhere
	}

	const record = node as Record<string, unknown>;
	const { types } = record;

	if (typeof types === "string") {
		return types;
	}

	if (types !== null && typeof types === "object") {
		const nested = types as Record<string, unknown>;
		const chosen = nested["default"] ?? nested["import"] ?? nested["require"];

		return typeof chosen === "string" ? chosen : undefined;
	}

	for (const condition of ["import", "require", "default"]) {
		const value = record[condition];

		if (value !== null && typeof value === "object" && typeof (value as Record<string, unknown>)["types"] === "string") {
			return (value as Record<string, unknown>)["types"] as string;
		}
	}

	for (const condition of ["import", "require", "default"]) {
		const beside = declarationBeside(record[condition]);

		if (beside !== undefined) {
			return beside;
		}
	}

	return undefined;
}

function collectFiles(node: MetaNode, out: Set<string>): void {
	for (const child of node.files ?? []) {
		if (child.type === "directory" || child.files !== undefined) {
			collectFiles(child, out);
		} else {
			out.add(child.path.replace(/^\/+/u, ""));
		}
	}
}

export function references(dts: string): { "relative": string[]; "packages": string[]; "imports": string[] } {
	const relative = new Set<string>();
	const packages = new Set<string>();
	const imports = new Set<string>();

	const code = dts.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|(?<!\/)\/\/(?!\/\s*<reference)[^\n]*/gu, (_, string: string | undefined) => string ?? "");

	for (const match of code.matchAll(new RegExp(SPECIFIER + String.raw`|\/\/\/\s*<reference\s+(path|types)\s*=\s*["']([^"']+)["']`, "gu"))) {
		const spec = match[1] ?? match[3];
		const [, , kind] = match; // "path" | "types" | undefined (a module specifier)

		if (spec !== undefined) {
			if (kind === "types") {
				packages.add(spec); // /// <reference types="node"> → a package
			} else if (spec.startsWith(".") || kind === "path") {
				relative.add(spec);
			} else if (spec.startsWith("#")) {
				imports.add(spec);
			} else {
				const pkg = packageRootOf(spec);

				if (pkg !== undefined) {
					packages.add(pkg);
				}
			}
		}
	}

	return { "relative": [...relative], "packages": [...packages], "imports": [...imports] };
}

function resolveImport(spec: string, imports: unknown): string | undefined {
	if (imports === null || typeof imports !== "object") {
		return undefined;
	}

	for (const [key, target] of Object.entries(imports as Record<string, unknown>)) {
		const star = key.indexOf("*");
		const [before, after] = star === -1 ? [key, ""] : [key.slice(0, star), key.slice(star + 1)];
		const matches = star === -1 ? spec === key : spec.startsWith(before) && spec.endsWith(after) && spec.length >= key.length - 1;
		const chosen = typeof target === "string" ? target : pickTypes(target);

		if (matches && chosen !== undefined) {
			return chosen.replace("*", spec.slice(before.length, spec.length - after.length));
		}
	}

	return undefined;
}

function resolveInMeta(fromSub: string, ref: string, files: Set<string>): string | undefined {
	const dir = fromSub.includes("/") ? fromSub.slice(0, fromSub.lastIndexOf("/")) : "";
	const joined = new URL(ref, "file:///" + (dir === "" ? "" : dir + "/")).pathname.slice(1); // package-relative, normalized (a root file's base is file:///, not file:////)
	const beside = declarationBeside(joined);

	for (const candidate of beside === undefined ? [joined, joined + ".d.ts", joined + ".d.mts", joined + ".d.cts", joined + "/index.d.ts"] : [beside]) {
		if (files.has(candidate)) {
			return candidate;
		}
	}

	return undefined; // not a real file in this package (escaped, or JS-only) — don't chase it
}

export function installTypeAcquisition(api: typeof vscode, workspaceFolder: string, versions: Record<string, string>, has: (absPath: string) => boolean, log: Logger): void {
	const nodeModules = workspaceFolder.replace(/\/$/u, "") + "/node_modules";
	const deployBase = location.pathname.slice(0, location.pathname.indexOf("/__vscode__/") + 1) || "/";

	const fetchedPath = new Set<string>();          // node_modules-relative paths already handled this session
	const seenPackage = new Set<string>();          // packages already acquired this session
	const metaCache = new Map<string, Set<string>>(); // pkg → its file set (from ?meta)
	const importsOf = new Map<string, unknown>();      // pkg → its package.json `imports` map
	const dependenciesOf = new Map<string, Set<string>>(); // pkg → what its package.json depends on

	const abs = (rel: string): string => `${nodeModules}/${rel}`;
	const HEALED = ".ata-crawl-2";
	const healing = !has(abs(HEALED));
	const readLocal = async (rel: string): Promise<string | undefined> => {
		try {
			return new TextDecoder().decode(await api.workspace.fs.readFile(api.Uri.file(abs(rel))));
		} catch {
			return undefined;
		}
	};

	const cdnText = async (rel: string, meta: boolean, budget: { "n": number }): Promise<string | undefined> => {
		if (budget.n <= 0) {
			return undefined;
		}

		budget.n -= 1;

		const pkg = packageRootOf(rel) ?? rel;
		const version = versions[pkg];
		let search: string;

		if (meta) {
			search = "?meta" + (version === undefined ? "" : "&v=" + version);
		} else {
			search = version === undefined ? "" : "?v=" + version;
		}

		if (aliases[pkg] !== undefined) {
			search += (search === "" ? "?" : "&") + "p=" + encodeURIComponent(aliases[pkg]);
		}

		try {
			const response = await fetch(new URL(`${deployBase}${nodeModules.replace(/^\//u, "")}/${rel}${search}`, location.href).href);

			if (!response.ok) {
				return undefined;
			}

			return await response.text();
		} catch {
			return undefined; // offline / CDN error — acquisition is best-effort
		}
	};

	let written = 0; // files ATA has added to the store this session (see the reload in `acquire`)

	const write = async (rel: string, code: string): Promise<void> => {
		if (installedLocally.has(packageRootOf(rel) ?? rel)) {
			return;
		}

		try {
			await api.workspace.fs.writeFile(api.Uri.file(`${nodeModules}/${rel}`), new TextEncoder().encode(code));
			written += 1;
		} catch { /* already seeded (read-only) or unwritable — the existing copy stands */ }
	};

	const packageFiles = async (pkg: string, budget: { "n": number }): Promise<Set<string>> => {
		const existing = metaCache.get(pkg);

		if (existing !== undefined) {
			return existing;
		}

		const raw = await cdnText(pkg, true, budget);
		const files = new Set<string>();

		if (raw !== undefined) {
			try {
				collectFiles(JSON.parse(raw) as MetaNode, files);
			} catch { /* malformed meta — treated as an empty listing */ }
		}

		metaCache.set(pkg, files);

		return files;
	};

	const acquireFile = async (pkg: string, sub: string, files: Set<string>, budget: { "n": number }): Promise<boolean> => {
		const rel = pkg + "/" + sub;

		if (fetchedPath.has(rel)) {
			return true; // already handled this session
		}

		fetchedPath.add(rel);

		const stored = has(abs(rel));

		if (stored && !healing) {
			return true; // already in the store (seed / persisted / earlier session) — its subtree is too
		}

		const code = stored ? await readLocal(rel) : await cdnText(rel, false, budget);

		if (code === undefined) {
			return false;
		}

		if (!stored) {
			await write(rel, code);
		}

		if (!DECL.test(sub)) {
			return true;
		}

		const { relative, imports, ...referenced } = references(code);
		const declared = pkg.startsWith("@types/") ? dependenciesOf.get(pkg) : undefined;
		const packages = declared === undefined ? referenced.packages : referenced.packages.filter((dep) => declared.has(dep) || declared.has(typesCounterpart(dep)));
		const targets = [
			...relative.map((ref) => resolveInMeta(sub, ref, files)),
			...imports.map((spec) => resolveImport(spec, importsOf.get(pkg))).filter((path) => path !== undefined).map((path) => resolveInMeta("", path, files))
		];

		await Promise.all([
			...targets.filter((target) => target !== undefined).map((target) => acquireFile(pkg, target, files, budget)),
			...packages.map((dep) => acquirePackage(dep, budget))
		]);

		return true;
	};

	const acquireSubpath = async (pkg: string, sub: string, budget: { "n": number }): Promise<void> => {
		if (installedLocally.has(pkg) || fetchedPath.has(`${pkg}#${sub}`)) {
			return;
		}

		fetchedPath.add(`${pkg}#${sub}`);

		await acquirePackage(pkg, budget);

		const pkgJsonRel = pkg + "/package.json";
		const pkgJson = has(abs(pkgJsonRel)) ? await readLocal(pkgJsonRel) : await cdnText(pkgJsonRel, false, budget);
		let exportsField: unknown;

		try {
			exportsField = pkgJson === undefined ? undefined : (JSON.parse(pkgJson) as Record<string, unknown>)["exports"];
		} catch { /* malformed package.json */ }

		const exported = exportedTypes(exportsField, sub)?.replace(/^\.\//u, "");
		const files = await packageFiles(pkg, budget);

		for (const candidate of exported === undefined ? [sub + ".d.ts", sub + "/index.d.ts"] : [exported]) {
			if (DECL.test(candidate) && (files.size === 0 || files.has(candidate)) && await acquireFile(pkg, candidate, files, budget)) {
				return;
			}
		}
	};

	const acquiring = new Map<string, Promise<void>>();

	async function acquirePackage(pkg: string, budget: { "n": number }): Promise<void> {
		const pending = acquiring.get(pkg);

		if (pending !== undefined) {
			return pending;
		}

		const done = acquirePackageNow(pkg, budget);

		acquiring.set(pkg, done);

		return done;
	}

	async function acquirePackageNow(pkg: string, budget: { "n": number }): Promise<void> {
		if (seenPackage.has(pkg) || installedLocally.has(pkg)) {
			return;
		}

		seenPackage.add(pkg);

		const pkgJsonRel = pkg + "/package.json";
		let stored = has(abs(pkgJsonRel));
		let local = stored ? await readLocal(pkgJsonRel) : undefined;

		if (stored && versions[pkg] !== undefined && versionOf(local) !== versions[pkg]) {
			await api.workspace.fs.delete(api.Uri.file(abs(pkg)), { "recursive": true }).then(() => undefined, () => undefined);
			stored = false;
			local = undefined;
		}

		const present = stored && !healing;
		const pkgJson = stored ? local : await cdnText(pkgJsonRel, false, budget);

		if (pkgJson === undefined) {
			if (!pkg.startsWith("@types/")) {
				await acquirePackage(typesCounterpart(pkg), budget);
			}

			return;
		}

		if (!stored) {
			fetchedPath.add(pkgJsonRel);
			await write(pkgJsonRel, pkgJson);
		}

		let entry: string | undefined;
		let subpaths: string[] = [];

		try {
			const meta = JSON.parse(pkgJson) as Record<string, unknown>;

			entry = typesEntry(meta);
			importsOf.set(pkg, meta["imports"]);
			dependenciesOf.set(pkg, new Set(Object.keys({ ...meta["dependencies"] as object, ...meta["peerDependencies"] as object })));
			subpaths = subpathTypes(meta).map((sub) => sub.replace(/^\.\//u, "")).filter((sub) => DECL.test(sub) && sub !== entry?.replace(/^\.\//u, ""));
		} catch { /* malformed package.json */ }

		entry = entry?.replace(/^\.\//u, "");

		const files = present ? new Set<string>() : await packageFiles(pkg, budget);

		if (entry === undefined && (present ? has(abs(pkg + "/index.d.ts")) : files.has("index.d.ts"))) {
			entry = "index.d.ts"; // no declared types but a conventional index.d.ts exists
		}

		const listed = (sub: string): boolean => files.size === 0 || files.has(sub);

		if (entry !== undefined && DECL.test(entry) && listed(entry)) {
			await acquireFile(pkg, entry, files, budget);
		} else if (!pkg.startsWith("@types/")) {
			await acquirePackage(typesCounterpart(pkg), budget); // ships no types → DefinitelyTyped counterpart
		}

		for (const sub of subpaths.filter(listed)) {
			await acquireFile(pkg, sub, files, budget);
		}
	}

	const acquireConfig = async (pkg: string, sub: string, budget: { "n": number }, depth = 0): Promise<void> => {
		await acquireFile(pkg, "package.json", new Set(), budget);

		if (await acquireFile(pkg, sub, new Set(), budget) && depth < 4) {
			const text = await readLocal(pkg + "/" + sub);

			for (const [next, nextSub] of extendsTargets(text === undefined ? undefined : parseJsonc(text))) {
				await acquireConfig(next, nextSub, budget, depth + 1);
			}
		}
	};

	let inFlight = 0;
	let writtenAtStart = 0;

	const acquire = (what: Record<string, unknown>, packages: string[], configs: [string, string][] = [], subpaths: [string, string][] = []): void => {
		const span = log.span("editor.workbench.ata.acquire", { ...what, "imports": packages.length });
		const budget = { "n": MAX_NETWORK };
		const writtenBefore = written;

		if (inFlight === 0) {
			writtenAtStart = written;
		}

		inFlight += 1;

		void waitFor(["versions"], PINS_MS)
			.then(async () => Promise.all([...packages.map((pkg) => acquirePackage(pkg, budget)), ...configs.map(([pkg, sub]) => acquireConfig(pkg, sub, budget)), ...subpaths.map(([pkg, sub]) => acquireSubpath(pkg, sub, budget))]))
			.then(async () => {
				if (healing && !has(abs(HEALED))) {
					await write(HEALED, "");
				}

				span.end({ "files": fetchedPath.size, "network": MAX_NETWORK - budget.n, "added": written - writtenBefore });
			})
			.catch((error: unknown) => {
				// eslint-disable-next-line ts/no-base-to-string -- a rejection's value is unknown: a non-Error one is logged as String() makes it
				span.error("ata failed", { "error": error instanceof Error ? error.message : String(error) });
				span.end();
			})
			.finally(() => {
				inFlight -= 1;

				if (inFlight === 0 && written > writtenAtStart) {
					void api.commands.executeCommand("typescript.reloadProjects");
				}
			});
	};

	const run = (document: vscode.TextDocument | undefined): void => {
		if (document?.uri.scheme !== "file" || !RELEVANT.test(document.uri.path) || document.uri.path.includes("/node_modules/")) {
			return;
		}

		const packages = importedPackages(document.getText());
		const subpaths = importedSubpaths(document.getText());

		if (packages.length > 0) {
			acquire({ "file": document.uri.path }, packages, [], subpaths);
		}
	};

	const runProject = async (): Promise<void> => log.span("editor.workbench.ata.project", {}, async (span) => {
		const root = workspaceFolder.replace(/\/$/u, "");
		const read = async (uri: vscode.Uri): Promise<Record<string, unknown> | undefined> => {
			try {
				return parseJsonc(new TextDecoder().decode(await api.workspace.fs.readFile(uri)));
			} catch {
				return undefined;
			}
		};

		const found = await api.workspace.findFiles(new api.RelativePattern(api.Uri.file(root), "**/{package.json,tsconfig.json}"), `{**/node_modules/**,${REFS_DIR}/**}`);
		const named = async (name: string): Promise<(Record<string, unknown> | undefined)[]> => Promise.all(found.filter((uri) => uri.path.endsWith("/" + name)).map(read));
		const [manifests, tsconfigs] = await Promise.all([named("package.json"), named("tsconfig.json")]);
		const declared = manifests.flatMap((manifest) => Object.keys({ ...manifest?.["dependencies"] as object, ...manifest?.["devDependencies"] as object })).filter((name) => name.startsWith("@types/"));
		const listed = tsconfigs.flatMap((tsconfig) => {
			const types = (tsconfig?.["compilerOptions"] as { "types"?: unknown } | undefined)?.types;

			return Array.isArray(types) ? types.filter((name): name is string => typeof name === "string").map((name) => packageRootOf(name) ?? name) : [];
		});
		const packages = [...new Set([...declared, ...listed])];
		const configs = [...new Map(tsconfigs.flatMap((tsconfig) => extendsTargets(tsconfig)).map((target) => [target.join("/"), target])).values()];

		if (configs.length > 0) {
			acquire({ "file": root + "/tsconfig.json" }, [], configs);
		}

		if (packages.length > 0) {
			acquire({ "file": root + "/{package.json,tsconfig.json}" }, packages);
		}

		span.end({ "manifests": manifests.length, "tsconfigs": tsconfigs.length, "count": packages.length, "configs": configs.length });
	});

	let timer: ReturnType<typeof setTimeout> | undefined;
	let projectTimer: ReturnType<typeof setTimeout> | undefined;
	const manifests = api.workspace.createFileSystemWatcher(new api.RelativePattern(api.Uri.file(workspaceFolder), "**/{package.json,tsconfig.json}"));
	const scheduleProject = (uri?: vscode.Uri): void => {
		if (uri?.path.includes("/node_modules/") === true) {
			return;
		}

		clearTimeout(projectTimer);
		projectTimer = setTimeout(() => {
			void runProject();
		}, DEBOUNCE_MS);
	};

	manifests.onDidCreate(scheduleProject);
	manifests.onDidChange(scheduleProject);
	void runProject();

	const schedule = (document: vscode.TextDocument | undefined): void => {
		if (timer !== undefined) {
			clearTimeout(timer);
		}

		timer = setTimeout(run, DEBOUNCE_MS, document);
	};

	api.window.onDidChangeActiveTextEditor((editor) => {
		schedule(editor?.document);
	});
	api.workspace.onDidChangeTextDocument((event) => {
		schedule(event.document);
	});
	run(api.window.activeTextEditor?.document); // acquire for whatever's already open
}

// Corpus loader for the round-trip oracle. Reuses ../tsval's OWN loaders and supported-surface policy filters
// (imported as TypeScript source — Node strips types), so "eligible here" === "eligible for tsval": the grammar
// target and the interpreter surface are the same set of programs by construction.
//
//   ts-cases        TypeScript tests/cases/{compiler,conformance} (single-file, non-module, clean, in-surface)
//   test262         tc39/test262 test/language (strict/unflagged, non-module, non-parser-negative, in-surface)
//   test262-harness the harness files every test262 program is prefixed with (plain JS)
//
// `sample` roots are what tsval checks in; `full` roots are its fetched pinned checkouts (gitignored there).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const defaultTsvalRoot = () => process.env.TSVAL_ROOT ?? resolve(here, "../../tsval");

const importTsval = (root, rel) => import(pathToFileURL(join(root, rel)).href);

/** Yields `{ corpus, id, name, source, skip }` for every case; `skip` is tsval's policy reason (undefined = eligible). */
export async function *loadCorpus({ corpora, size = "sample", tsvalRoot = defaultTsvalRoot() }) {
	if (!existsSync(tsvalRoot)) { throw new Error(`tsval root not found: ${tsvalRoot} (set TSVAL_ROOT)`); }

	if (corpora.includes("ts-cases")) {
		const mod = await importTsval(tsvalRoot, "test/differential/ts-cases-corpus.ts");
		const root = size === "full" ? mod.FULL_ROOT : mod.SAMPLE_ROOT;

		if (!mod.hasCorpus(root)) { throw new Error(`ts-cases corpus missing at ${root}`); }
		for (const t of mod.loadTsCases(root)) {
			const skip = mod.policySkip(t);

			yield { "corpus": "ts-cases", "id": t.id, "name": t.files[0]?.name || "case.ts", "source": mod.caseSource(t), "skip": skip };
		}
	}

	if (corpora.includes("test262")) {
		const corpusMod = await importTsval(tsvalRoot, "test/differential/test262-corpus.ts");
		const runMod = await importTsval(tsvalRoot, "test/differential/test262-run.ts");
		const root = size === "full" ? corpusMod.FULL_ROOT : corpusMod.SAMPLE_ROOT;

		if (!corpusMod.hasCorpus(root)) { throw new Error(`test262 corpus missing at ${root}`); }
		for (const t of corpusMod.loadTest262(root)) {
			const skip = runMod.policySkip(t);

			yield { "corpus": "test262", "id": t.id, "name": "test.js", "source": t.source, "skip": skip };
		}

		if (corpora.includes("test262-harness") || true) {
			const harnessDir = join(root, "harness");

			for (const name of readdirSync(harnessDir).sort()) {
				if (!name.endsWith(".js")) { continue; }
				yield { "corpus": "test262-harness", "id": name, "name": name, "source": readFileSync(join(harnessDir, name), "utf8"), "skip": undefined };
			}
		}
	}
}

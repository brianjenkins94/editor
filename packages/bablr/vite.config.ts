import { createHash } from "node:crypto";
import * as url from "node:url";
import * as fs from "@brianjenkins94/util/fs";
import { defaults } from "@brianjenkins94/util/vite/defaults";
import { mergeConfig } from "vite";

// Bundle the bablr parse surface (`cstSpans`) with @bablr/record's validation neutralized. `@bablr/record`'s
// recursive `validate` walk (~30% of a parse) is a dev aid; we alias the package to a vendored shim whose
// `strict` flag is the `__BABLR_RECORD_STRICT__` define, folded to `false` so rollup tree-shakes the validate
// walk out entirely. This replaces patch-package — no node_modules mutation, no post-install step.
// What a parse (cstSpans) depends on: the grammar, the span walk, and BABLR's packages (by the versions asked for).
// Hashed into PARSE_VERSION, so a cache of parses (the editor's BABLR worker) drops entries a change makes stale.
const parseInputs = ["../bablr-language-ts/lib/grammar.ts", "../bablr-language-ts/lib/spans.ts", "../bablr-language-ts/package.json", "./package.json", "./shims/record.js"];
const parseVersion = createHash("sha1").update(parseInputs.map((file) => fs.readFileSync(url.fileURLToPath(new URL(file, import.meta.url)))).join("\0")).digest("hex").slice(0, 12);

export default mergeConfig(defaults, {
	"define": { "__BABLR_RECORD_STRICT__": "false", "__BABLR_PARSE_VERSION__": JSON.stringify(parseVersion) },
	"resolve": {
		"alias": [
			{ "find": /^@bablr\/record(?:\/.*)?$/u, "replacement": url.fileURLToPath(new URL("./shims/record.js", import.meta.url)) }
		]
	},
	"build": {
		"lib": {
			"entry": url.fileURLToPath(new URL("./src/index.js", import.meta.url)),
			"formats": ["es"],
			"fileName": "index"
		}
	}
});

import * as url from "node:url";
import { defaults } from "@brianjenkins94/util/vite/defaults";
import { mergeConfig } from "vite";

// Bundle the bablr parse surface (`cstSpans`) with @bablr/record's validation neutralized. `@bablr/record`'s
// recursive `validate` walk (~30% of a parse) is a dev aid; we alias the package to a vendored shim whose
// `strict` flag is the `__BABLR_RECORD_STRICT__` define, folded to `false` so rollup tree-shakes the validate
// walk out entirely. This replaces patch-package — no node_modules mutation, no post-install step.
export default mergeConfig(defaults, {
	"define": { "__BABLR_RECORD_STRICT__": "false" },
	"resolve": {
		"alias": [
			{ "find": /^@bablr\/record(?:\/.*)?$/, "replacement": url.fileURLToPath(new URL("./shims/record.js", import.meta.url)) }
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

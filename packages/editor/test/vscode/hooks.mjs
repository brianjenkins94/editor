// `import * as vscode from "vscode"` in an extension under test resolves to the stand-in (fake.ts): imported first by a
// test, this hooks resolution for every module loaded after it — `require` too, which is how tsx loads the extension.
import { registerHooks } from "node:module";

const FAKE = new URL("./fake.ts", import.meta.url).href;

registerHooks({
	"resolve": (specifier, context, next) => (specifier === "vscode" ? { "url": FAKE, "shortCircuit": true } : next(specifier, context))
});

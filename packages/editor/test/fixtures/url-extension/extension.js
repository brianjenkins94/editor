// An extension from outside the editor, as editor-contrib's template builds one (CommonJS, `vscode` its host's): its one
// command answers, so workbench.mjs can tell it loaded and ran.
const vscode = require("vscode");

exports.activate = (context) => {
	context.subscriptions.push(vscode.commands.registerCommand("urlExtension.hello", () => "hello from a URL"));
};

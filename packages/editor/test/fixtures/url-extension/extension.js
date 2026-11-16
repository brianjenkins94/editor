// An extension from outside the editor, as editor-contrib's template builds one (CommonJS, `vscode` its host's): its one
// command says so, so in-editor/workbench.spec.mjs can see it loaded and ran.
const vscode = require("vscode");

exports.activate = (context) => {
	context.subscriptions.push(vscode.commands.registerCommand("urlExtension.hello", () => {
		void vscode.window.showInformationMessage("hello from a URL");

		return "hello from a URL";
	}));
};

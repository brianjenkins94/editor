import { observeExtension } from "@brianjenkins94/editor-api/runtime";
import * as vscode from "vscode";
import { InterpreterSession } from "./interpreter";
import { Renderer } from "./renderer";

export function activate(context: vscode.ExtensionContext): void {
	// On the editor's observability plane: what this logs is the editor's log too (debug-mcp's logs_query), as ext:contrib's.
	const observed = observeExtension("contrib");

	if (observed !== undefined) {
		context.subscriptions.push(observed);
		observed.log.info("editor-contrib's extension is up");
	}

	context.subscriptions.push(
		vscode.debug.registerDebugAdapterDescriptorFactory("contrib", {
			"createDebugAdapterDescriptor": (session) => new vscode.DebugAdapterInlineImplementation(new InterpreterSession(session))
		}),
		vscode.window.registerCustomEditorProvider("contrib.renderer", new Renderer())
	);
}

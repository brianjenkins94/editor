import * as vscode from "vscode";
import { InterpreterSession } from "./interpreter";
import { Renderer } from "./renderer";

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.debug.registerDebugAdapterDescriptorFactory("contrib", {
			"createDebugAdapterDescriptor": (session) => new vscode.DebugAdapterInlineImplementation(new InterpreterSession(session))
		}),
		vscode.window.registerCustomEditorProvider("contrib.renderer", new Renderer())
	);
}

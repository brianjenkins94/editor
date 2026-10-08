import * as vscode from "vscode";
import { InterpreterSession } from "./interpreter";
import { Renderer } from "./renderer";

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.debug.registerDebugAdapterDescriptorFactory("contrib", {
			createDebugAdapterDescriptor: () => new vscode.DebugAdapterInlineImplementation(new InterpreterSession())
		}),
		vscode.window.registerCustomEditorProvider("contrib.renderer", new Renderer())
	);
}

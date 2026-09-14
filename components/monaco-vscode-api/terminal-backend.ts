/**
 * The default terminal backend, with a pluggable process factory.
 *
 * The editor registers the real process (just-bash on the workspace filesystem — see packages/vscode/terminal.ts)
 * via setTerminalProcessFactory; this backend delegates every terminal to it. Both this and that factory run in
 * the workbench realm, so a module-level registration bridges them without the component importing UP into the
 * editor.
 *
 * The workbench can create the boot terminal BEFORE the editor registers the factory (registration waits on the
 * captured extension API), so createProcess must WAIT for the factory rather than fall back — otherwise the boot
 * terminal shows a stub. Input typed before the factory arrives is buffered and replayed.
 *
 * (Replaces the vendored demo `TerminalBackend`, which lived in the gitignored `demo/` tree and so couldn't carry
 * a committed change.)
 */
import {
	ITerminalChildProcess,
	SimpleTerminalBackend,
	SimpleTerminalProcess
} from "@codingame/monaco-vscode-terminal-service-override";
import * as vscode from "vscode";

export interface TerminalProcess {
	start: () => void;
	input: (data: string) => void;
	resize?: (cols: number, rows: number) => void;
	shutdown?: () => void;
}

export type TerminalProcessFactory = (fire: (data: string) => void, cwd: string) => TerminalProcess;

let terminalProcessFactory: TerminalProcessFactory | undefined;
const factoryWaiters: ((factory: TerminalProcessFactory) => void)[] = [];

/** Register the process factory used for every terminal the workbench opens. Called once by the editor at boot. */
export function setTerminalProcessFactory(factory: TerminalProcessFactory): void {
	terminalProcessFactory = factory;

	for (const resolve of factoryWaiters.splice(0)) {
		resolve(factory);
	}
}

/** Resolve with the factory — now if already registered, else when setTerminalProcessFactory is called. */
function whenFactory(): Promise<TerminalProcessFactory> {
	return terminalProcessFactory !== undefined ? Promise.resolve(terminalProcessFactory) : new Promise((resolve) => { factoryWaiters.push(resolve); });
}

export class TerminalBackend extends SimpleTerminalBackend {
	override getDefaultSystemShell = async (): Promise<string> => "bash";
	override createProcess = async (): Promise<ITerminalChildProcess> => {
		const dataEmitter = new vscode.EventEmitter<string>();
		const cwd = "/workspace";
		let process: TerminalProcess | undefined;
		let buffered = "";

		class WorkspaceTerminalProcess extends SimpleTerminalProcess {
			async start(): Promise<undefined> {
				const factory = await whenFactory(); // may resolve after boot creates this process

				process = factory((data) => dataEmitter.fire(data), cwd);
				process.start();

				if (buffered !== "") {
					process.input(buffered);
					buffered = "";
				}

				return undefined;
			}

			override input(data: string): void {
				if (process !== undefined) {
					process.input(data);
				} else {
					buffered += data; // typed before the factory arrived — replayed in start()
				}
			}

			resize(cols: number, rows: number): void {
				process?.resize?.(cols, rows);
			}

			override shutdown(immediate: boolean): void {
				process?.shutdown?.();
				void immediate;
			}

			override clearBuffer(): void | Promise<void> { /* nothing buffered */ }

			override sendSignal(): void { /* not supported */ }
		}

		return new WorkspaceTerminalProcess(1, 1, cwd, dataEmitter.event);
	};
}

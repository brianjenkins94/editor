// The interpreter's worker: where a program runs, off the extension host. It reaches the editor through the workspace
// runtime (`connectRuntime`): its files, read and written synchronously — the program's calls decided by the editor's
// policy, as every run's are — its log, and the preview's requests for a server the program starts. It tells the debug
// adapter (interpreter.ts) what happened as it goes, and the adapter tells the editor.
import type { Events } from "@brianjenkins94/run-contract";
import type { RuntimeConnection } from "@brianjenkins94/run-contract/runtime";
import { connectRuntime } from "@brianjenkins94/run-contract/runtime";

/** What the adapter sends: the runtime link (inside the editor), then a program to run. */
export type ToWorker =
	| { "kind": "runtime"; "port": MessagePort }
	| { "kind": "run"; "program": string; "source": string };

/** What the worker sends back: one of the contract's events, what the program printed, or that it's done. */
export type FromWorker =
	| { [Name in keyof Events]: { "kind": "event"; "name": Name; "body": Events[Name] } }[keyof Events]
	| { "kind": "output"; "text": string }
	| { "kind": "exited"; "exitCode": number };

let runtime: RuntimeConnection | undefined;

function send(message: FromWorker): void {
	postMessage(message);
}

function tell<Name extends keyof Events>(name: Name, body: Events[Name]): void {
	send({ "kind": "event", "name": name, "body": body } as FromWorker);
}

/** Run `program`, telling the editor what happened as it goes. */
async function run(program: string, given: string): Promise<void> {
	await runtime?.ready;

	// The program, as the editor has it (an open editor's unsaved text included). `load`: the interpreter's own read —
	// a call the program makes (`runtime.fs.readFile(path)`, `writeFile`, …) is decided by the policy instead.
	const source = runtime === undefined ? given : new TextDecoder().decode(runtime.fs.readFile(program, { "load": true }));

	runtime?.log.info(`running ${program}`);

	// TODO: interpret `source`. Write what it prints with `output`, and tell values as they happen:
	send({ "kind": "output", "text": `would run ${program} (${source.length} characters)\n` });
	tell("values", { "file": program, "source": source, "values": [], "calls": [], "dropped": 0 });
	// …every statement that could run, with how often it did…
	tell("coverage", { "file": program, "source": source, "statements": [], "sites": [] });
	// …what it did to the world that the editor didn't see — requests and commands it made itself (its calls through
	// `runtime.fs` the editor keeps among the run's effects already)…
	tell("effects", { "effects": [] });
	// …and that it's over: its values go from the margin, and where it crashed or was stopped (`end`) is marked.
	tell("ended", { "file": program, "source": source });
	send({ "kind": "exited", "exitCode": 0 });
}

addEventListener("message", (event: MessageEvent<ToWorker>) => {
	const message = event.data;

	if (message.kind === "runtime") {
		runtime = connectRuntime(message.port, { "name": "contrib-interpreter" });
	} else {
		void run(message.program, message.source);
	}
});

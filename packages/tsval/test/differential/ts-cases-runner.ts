/**
 * Runs TypeScript cases in a child process (see ts-cases-worker.ts): a heap limit and a wall-clock
 * timeout bound each case; a case that kills the child (memory, a V8 fatal abort) or never finishes
 * is reported as inconclusive and the child is replaced. Cases run sequentially; the child is reused.
 */
import type { ChildProcess } from "node:child_process";
import type { TsCaseOutcome } from "./ts-cases-run.ts";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const HEAP_MB = 768;
const WALL_CLOCK_MS = 15_000;
const ENTRY = fileURLToPath(new URL("./ts-cases-worker.ts", import.meta.url));

export class CaseRunner {
	private child: ChildProcess | undefined;
	private seq = 0;
	/** unhandled rejections seen inside the child (guest async work failing after its case). */
	lateRejections = 0;

	private spawn(): ChildProcess {
		return fork(ENTRY, [], { "execArgv": [`--max-old-space-size=${HEAP_MB}`], "stdio": ["ignore", "ignore", "ignore", "ipc"] });
	}

	run(root: string, id: string): Promise<TsCaseOutcome> {
		const child = (this.child ??= this.spawn());
		const seq = ++this.seq;

		return new Promise((resolve) => {
			const finish = (outcome: TsCaseOutcome, replace: boolean): void => {
				clearTimeout(timer);
				child.off("message", onMessage);
				child.off("exit", onExit);
				child.off("error", onError);
				if (replace) {
					child.kill("SIGKILL");
					this.child = undefined;
				}

				resolve(outcome);
			};

			const timer = setTimeout(finish, WALL_CLOCK_MS, { "kind": "inconclusive", "reason": `runner killed: a side did not finish within ${WALL_CLOCK_MS / 1000}s` }, true);
			const onMessage = (m: { "seq": number; "outcome": TsCaseOutcome; "lateRejections": number }): void => {
				if (m.seq !== seq) { return; }
				this.lateRejections = m.lateRejections;
				finish(m.outcome, false);
			};

			const onExit = (code: number | null, signal: string | null): void => { finish({ "kind": "inconclusive", "reason": `runner died (${signal ?? `exit ${code}`}): the case exhausted memory or aborted the engine` }, true); };
			const onError = (error: unknown): void => { finish({ "kind": "inconclusive", "reason": `runner died: ${String((error as Error)?.message ?? error).slice(0, 100)}` }, true); };

			child.on("message", onMessage);
			child.on("exit", onExit);
			child.on("error", onError);
			child.send({ "seq": seq, "root": root, "id": id });
		});
	}

	async close(): Promise<void> {
		const { child } = this;

		this.child = undefined;
		if (child === undefined) { return; }
		await new Promise<void>((resolve) => {
			child.once("exit", () => { resolve(); });
			child.kill("SIGKILL");
		});
	}
}

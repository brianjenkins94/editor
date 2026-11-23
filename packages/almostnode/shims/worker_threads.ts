/**
 * worker_threads' Worker: unenv's, which constructs and never runs — tools make one as they load and never use it here
 * (eslint-plugin-jsonc, through synckit), and one that threw as it's made broke them. But a program that waits on one
 * would wait forever (a test blocked 16 minutes on a message that never came, 2026-11-23). So once something waits on
 * it — listens for its `message`, `online`, `error` or `exit`, or posts to it — it fails as Node's does when a worker
 * can't start: `error` (ERR_WORKER_INIT_FAILED), to whoever listens for one, then `exit`.
 */
import { Worker as UnenvWorker } from "unenv/node/worker_threads";

const WAITED_ON = new Set<string | symbol>(["message", "online", "error", "exit", "messageerror"]);

export class Worker extends UnenvWorker {
	#failing = false;

	public override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
		super.on(event, listener);
		this.#waitedOn(event);

		return this;
	}

	public override once(event: string | symbol, listener: (...args: unknown[]) => void): this {
		super.once(event, listener);
		this.#waitedOn(event);

		return this;
	}

	public override addListener(event: string | symbol, listener: (...args: unknown[]) => void): this {
		super.addListener(event, listener);
		this.#waitedOn(event);

		return this;
	}

	public override postMessage(value: unknown, transferList?: readonly unknown[]): void {
		super.postMessage(value, transferList as never);
		this.#waitedOn("message");
	}

	#waitedOn(event: string | symbol): void {
		if (this.#failing || !WAITED_ON.has(event)) {
			return;
		}

		this.#failing = true;
		setTimeout(() => {
			if (this.listenerCount("error") > 0) {
				this.emit("error", Object.assign(new Error("a worker thread can't run here: worker_threads' Worker isn't supported"), { "code": "ERR_WORKER_INIT_FAILED" }));
			}

			this.emit("exit", 1);
		}, 0);
	}
}

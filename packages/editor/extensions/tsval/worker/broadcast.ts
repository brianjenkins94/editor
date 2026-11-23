export function runBroadcastChannel(): typeof BroadcastChannel {
	const named = new Map<string, Set<RunChannel>>();

	class RunChannel extends EventTarget {
		public onmessage: ((event: MessageEvent) => void) | null = null;
		public onmessageerror: ((event: MessageEvent) => void) | null = null;
		public readonly name: string;
		#closed = false;

		public constructor(name: string) {
			super();
			this.name = String(name);
			named.set(this.name, (named.get(this.name) ?? new Set()).add(this));
		}

		public postMessage(message: unknown): void {
			if (this.#closed) {
				throw new DOMException("BroadcastChannel is closed", "InvalidStateError");
			}

			const data = structuredClone(message);

			for (const other of named.get(this.name) ?? []) {
				if (other !== this) {
					setTimeout(() => { other.#deliver(data); }, 0);
				}
			}
		}

		public close(): void {
			this.#closed = true;
			named.get(this.name)?.delete(this);
		}

		public ref(): this {
			return this;
		}

		public unref(): this {
			return this;
		}

		#deliver(data: unknown): void {
			if (this.#closed) {
				return;
			}

			const event = new MessageEvent("message", { "data": data });

			this.onmessage?.(event);
			this.dispatchEvent(event);
		}
	}

	return RunChannel as unknown as typeof BroadcastChannel;
}

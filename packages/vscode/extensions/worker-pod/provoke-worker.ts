/**
 * The provoke child worker — a throwaway realm spawned once per hardReset round by node-worker's
 * `preview.provoke` handler (see there). Its whole reason to exist is a COLD module graph: a freshly-spawned
 * worker has never imported `@brianjenkins94/almostnode` (and thus never loaded its `typescript` transpiler
 * chunk), so the FIRST ViteDevServer transform here reproduces the real cold-start window — the one a warm
 * in-process restart can't, because the parent's module cache keeps ts hot. We mount the same workspace SAB,
 * cold-import almostnode, build one server, fire the whole module set CONCURRENTLY (the concurrency is the
 * provocation), report which transforms lost the race (500 or a reported transform error), and then idle until
 * the parent terminates us. One message in, one message out.
 */
import { mountWorkspaceVfs } from "./zenfs-vfs.js";

interface ProvokeRequest { "buffer": SharedArrayBuffer; "root": string; "port": number; "modules": string[] }
interface ProvokeReply { "ok": boolean; "failures": Array<{ "url": string; "status": number }>; "transformErrors": Array<{ "url": string; "name": string; "message": string }>; "error"?: string }

globalThis.addEventListener("message", (event: MessageEvent) => {
	const request = event.data as ProvokeRequest | undefined;

	if (request === undefined || !(request.buffer instanceof SharedArrayBuffer)) {
		return;
	}

	void (async (): Promise<void> => {
		const reply: ProvokeReply = { "ok": true, "failures": [], "transformErrors": [] };

		try {
			const vfs = await mountWorkspaceVfs(request.buffer);
			// COLD import — this is the first time this realm pulls in almostnode + its typescript chunk.
			const { ViteDevServer } = await import("@brianjenkins94/almostnode");
			const server = new ViteDevServer(vfs, { "port": request.port, "root": request.root }) as unknown as {
				"start": () => void;
				"setTransformErrorReporter": (reporter: (info: { "url": string; "name": string; "message": string }) => void) => void;
				"handleRequest": (method: string, url: string, headers: Record<string, string>) => Promise<{ "statusCode": number }>;
			};

			server.start();
			server.setTransformErrorReporter((info) => { reply.transformErrors.push({ "url": info.url, "name": info.name, "message": info.message }); });

			// Fire the whole set at once against the cold server — losing this race is what we're hunting.
			const results = await Promise.all(request.modules.map(async (url) => {
				const response = await server.handleRequest("GET", url, {});

				return { "url": url, "status": response.statusCode };
			}));

			for (const result of results) {
				if (result.status >= 500) {
					reply.failures.push({ "url": result.url, "status": result.status });
				}
			}
		} catch (error) {
			reply.ok = false;
			reply.error = error instanceof Error ? error.message : String(error);
		}

		(globalThis as unknown as { "postMessage": (message: unknown) => void }).postMessage(reply);
	})();
});

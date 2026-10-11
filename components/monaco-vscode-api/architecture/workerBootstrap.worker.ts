/**
 * Core's way into a worker (the monaco editor workers, the web worker extension host): a generic entry that runs core's
 * code first — its port to core (workerPort.ts), the architecture probe, the workspace runtime — then loads the real
 * worker, whose url rides the hash (`#target=<encoded url>`, see `wrapWorkerUrls` in probes.ts). First is the point:
 * before VS Code's extension host takes `postMessage` from its extensions. The hash is never sent to the server and
 * survives the query parameters VSCode appends — which may land AFTER it, hence the split.
 */
import "./workerPort";
import "./probe.worker";
import "../runtime.worker";

const hash = new URL(import.meta.url).hash.slice(1).split(/[?#]/u)[0] ?? "";
const target = new URLSearchParams(hash).get("target");

if (target === null) {
	throw new Error("worker bootstrap: missing target worker url");
}

await import(/* @vite-ignore */ target);

/**
 * Generic worker entry: installs the probe, then loads the real worker whose url rides the hash
 * (`#target=<encoded url>`, see `wrapWorkerUrl` in probes.ts). The hash is never sent to the server and survives
 * the query parameters VSCode appends — which may land AFTER it, hence the split.
 */
import "./probe.worker";

const hash = new URL(import.meta.url).hash.slice(1).split(/[?#]/u)[0] ?? "";
const target = new URLSearchParams(hash).get("target");

if (target === null) {
	throw new Error("architecture probe: missing target worker url");
}

await import(/* @vite-ignore */ target);

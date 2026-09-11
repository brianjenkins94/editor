/**
 * Vendored, trimmed almostnode — an in-browser node runtime.
 *
 * Upstream (macaly/almostnode@0.2.14, MIT) ships a large surface: worker/sandbox runtimes, dev servers,
 * framework adapters, an AI agent workbench, xterm terminal, and several demos, dragging in @ai-sdk/*, ai,
 * zod, @xterm/*, comlink, css-tree, just-bash, brotli-wasm, and more. The editor uses only the same-origin,
 * main-thread `Runtime` (via `createRuntime`) to run bundled node language servers. This vendored copy keeps
 * just that path so we can prune the dependency tree and own the source.
 *
 * This barrel intentionally exports only what the editor consumes; see create-runtime.ts / runtime.ts.
 */
export { VirtualFS } from "./virtual-fs";
export type { FSNode, Stats, FSWatcher, WatchListener, WatchEventType } from "./virtual-fs";
export { Runtime, execute } from "./runtime";
export type { Module, RuntimeOptions, RequireFunction } from "./runtime";
export { createRuntime } from "./create-runtime";
export type { IRuntime, IExecuteResult, CreateRuntimeOptions, IRuntimeOptions, VFSSnapshot } from "./runtime-interface";

// Preview dev server (Path B): a Vite-compatible dev server that runs in the page, serves the VirtualFS with
// `ts.transpileModule` JSX/TS transforms + React-Refresh HMR, and is reached from the preview iframe through
// the ServerBridge service worker (`/__virtual__/<port>/`). See frameworks/vite-dev-server.ts.
export { DevServer } from "./dev-server";
export type { DevServerOptions, ResponseData, HMRUpdate } from "./dev-server";
export { ViteDevServer } from "./frameworks/vite-dev-server";
export type { ViteDevServerOptions } from "./frameworks/vite-dev-server";
export { ServerBridge, getServerBridge, resetServerBridge } from "./server-bridge";
export type { IVirtualServer, VirtualServer, BridgeOptions, InitServiceWorkerOptions } from "./server-bridge";

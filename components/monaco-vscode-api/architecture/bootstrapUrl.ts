// The literal `new Worker(new URL(...))` (with the fake Worker) is what makes vite emit the bootstrap as a worker entry.
import { Worker } from "../demo/src/tools/fakeWorker";

export const probeBootstrapUrl = new Worker(new URL("./probeBootstrap.worker.ts", import.meta.url), { "type": "module" }).url.toString();

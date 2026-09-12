/**
 * The pod hub — the worker-pod extension's own message hub (see @brianjenkins94/hub).
 *
 * It's the root of the extension's subtree: the ext host owns it, each worker links UP to it, and it works
 * entirely standalone (no harness required). When a harness is present, the workbench links this pod hub up to
 * the page's root hub, so a subject the page cares about (render output, logs) federates outward — but the pod
 * never depends on that link existing. This is the clean extension/harness boundary: the pod speaks hub
 * subjects and degrades to a standalone root when nothing is above it.
 */
import { createHub } from "@brianjenkins94/hub";

export const podHub = createHub({ "id": "pod" });

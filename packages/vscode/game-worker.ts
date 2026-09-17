/**
 * Game-maker parse worker — runs the BABLR CST parse + projection extraction OFF the main thread (BABLR is a slow
 * VM interpreter). Like node-worker, it's a pod-style member: its own hub links UP to the workbench over the
 * worker port, so it's reachable by hub RPC (`game.project`) and its spans/logs federate to the `$sys.log.>`
 * collector. This is the ONLY place `game-extract`/`game-cst` (and thus the BABLR parser + TS grammar) load, so
 * the workbench bundle stays BABLR-free — the view is a thin RPC client.
 */
import "./bablr-fast-freeze"; // MUST be first: neutralizes record freezing before game-extract → BABLR loads
import { createHub, portTransport, serve } from "@brianjenkins94/hub";

import { extractProjection } from "./game-extract";
import { relayLoggerToHub, tapConsoleAndErrors } from "./telemetry";

import type { ProjectSources } from "./game-model";

const hub = createHub({ "id": "game" });

hub.link(portTransport(globalThis));

const log = relayLoggerToHub(hub, "game");

tapConsoleAndErrors(hub, "game"); // raw uncaught error/rejection → the plane, beside the structured logs

// Project a game's sources into the plain GameProjection model. Identity reidentifies from the prior snapshots
// the client read out of the `.ts.bablr` sidecars, so ids carry across edits (and survive a worker restart — the
// FILE is the baseline). The returned `snapshots` are the new sidecar contents the client writes back. One request
// at a time is fine — the view debounces. The span times each parse so "BABLR is slow" stays observable.
serve(hub, "game.project", (args) => {
	const sources = args as ProjectSources;
	const span = log.span("project", { "level": sources.levelFile, "schemas": sources.schemas.length, "systems": sources.systems.length });

	try {
		return extractProjection(sources, sources.priorSnapshots);
	} finally {
		span.end();
	}
});

// Announce readiness so the client only requests once `serve` is registered + its interest has propagated up the
// link (a request published before then is dropped — the hub is fire-and-forget). Mirrors node-worker's node.ready.
hub.publish("game.ready");


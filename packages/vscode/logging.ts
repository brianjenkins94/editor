/**
 * The host page's logger.
 *
 * The workbench (and preview) run in their own iframes/windows (see vscode.tsx), each a separate JS realm
 * with its own console. Cross-window log federation is handled by the hub/observability plane (telemetry.ts →
 * `installHubCollector` / `linkDebugMcp`), which funnels every pane's structured records back to the host. This
 * module is only the host page's own `logger({ source: "host" })`, so host and pane logs share one format.
 *
 * (An earlier postMessage-based relay lived here — `installLogAggregator` / `installLogRelay`; it was superseded
 * by the hub and removed once nothing referenced it.)
 */
import type { Logger } from "@brianjenkins94/util/logger";
import { logger } from "@brianjenkins94/util/logger";

/** The host page's own logger — its records print through the default console sink locally. */
export const hostLog: Logger = logger({ "source": "host" });

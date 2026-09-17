/**
 * The observability plane now lives in the reusable `@brianjenkins94/observability` package (relay + collector +
 * the service-worker / debug-mcp links), so a game or any other host wires the same plane without copying it. This
 * file stays as the editor's local import point — existing `./telemetry` imports keep working unchanged.
 */
export { consoleCollector, installHubCollector, linkDebugMcp, linkServiceWorkerHub, LOG_SUBJECT, relayLoggerToHub, servePageTools, tapConsoleAndErrors } from "@brianjenkins94/observability";

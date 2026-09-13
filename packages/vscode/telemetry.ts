/**
 * The observability plane now lives in the reusable `@brianjenkins94/observability` package (relay + collector +
 * the service-worker / dev-hub links), so a game or any other host wires the same plane without copying it. This
 * file stays as the editor's local import point — existing `./telemetry` imports keep working unchanged.
 */
export { LOG_SUBJECT, relayLoggerToHub, installHubCollector, consoleCollector, linkServiceWorkerHub, linkDevHub } from "@brianjenkins94/observability";

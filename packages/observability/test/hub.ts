/**
 * hub's source, for the tests, typed as the published package observability's own code takes (`@brianjenkins94/hub`,
 * installed under node_modules, where Node won't strip TypeScript): one hub, two declarations of its classes — so what
 * the tests make is the `Hub` observability's code expects.
 */
import type * as Published from "@brianjenkins94/hub";
import * as source from "../../hub/src/index.ts";

const hub = source as unknown as typeof Published;

export const { createHub, createRpcClient, pipe, serve } = hub;

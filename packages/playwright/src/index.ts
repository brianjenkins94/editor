/**
 * The editor's Playwright: Playwright's Page, Locator and expect, run in the browser against a page in reach (README.md).
 */
export type { Action, Op, Outcome, Step, TextMatch } from "./engine.ts";
export { run } from "./engine.ts";
export { windowDriver } from "./driver.ts";
export { expect } from "./expect.ts";
export type { Driver } from "./locator.ts";
export { FrameLocator, Locator, Page, TimeoutError } from "./locator.ts";
export type { Fetched, FetchInit, RequestOptions } from "./request.ts";
export type { FulfillOptions, RouteAnswer, Routed, RouteMatch, UrlMatcher } from "./route.ts";
export { matchesCrossed, Request, Route } from "./route.ts";
export { APIRequestContext, APIResponse, fetched, requestInit } from "./request.ts";

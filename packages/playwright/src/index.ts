/**
 * The editor's Playwright: Playwright's Page, Locator and expect, run in the browser against a page in reach (README.md).
 */
export type { Action, Op, Outcome, Step, TextMatch } from "./engine.ts";
export { run } from "./engine.ts";
export { windowDriver } from "./driver.ts";
export { expect } from "./expect.ts";
export type { Driver } from "./locator.ts";
export { Locator, Page, TimeoutError } from "./locator.ts";

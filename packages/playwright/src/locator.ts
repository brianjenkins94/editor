/**
 * The API side of the editor's Playwright: `Page` and `Locator`, Playwright's names and behavior, over a driver that
 * runs an op where the page's DOM is (engine.ts `run`) — in the same realm (driver.ts `windowDriver`), or from a test in
 * the debugger by a request to the shell. A locator is its steps, nothing found until it's used; an action asks again
 * until its element can take it, or its timeout passes, as Playwright's auto-waiting does.
 */
import type { Action, Op, Outcome, Step, TextMatch } from "./engine.ts";

/** Where a page's ops run, and how it's navigated. */
export interface Driver {
	"run": (op: Op) => Promise<Outcome>;
	"goto"?: (url: string) => Promise<void>;
	"url"?: () => Promise<string>;
	"title"?: () => Promise<string>;
}

/** A timeout passing, as Playwright's TimeoutError. */
export class TimeoutError extends Error {
	public override name = "TimeoutError";
}

type Text = string | RegExp;

/** A text to match, as it crosses to the page: a RegExp as its source and flags. */
export function textMatch(text: Text): TextMatch {
	return typeof text === "string" ? text : { "source": text.source, "flags": text.flags };
}

const shown = (text: Text): string => (typeof text === "string" ? JSON.stringify(text) : String(text));

/** How long to wait between asks: soon at first, then less often — as Playwright polls. */
const BACKOFF = [0, 20, 50, 100, 100, 250, 500];

/** Ask `driver` to run `op` until it's done or `timeout` ms pass: its value, or an error naming `what` and why it waited. */
export async function untilDone(driver: Driver, op: Op, timeout: number, what: string): Promise<unknown> {
	const deadline = Date.now() + timeout;
	let why: string;

	for (let attempt = 0; ; attempt += 1) {
		const outcome = await driver.run(op);

		if ("error" in outcome) {
			throw new Error(`${what}: ${outcome.error}`);
		}

		if (outcome.done) {
			return outcome.value;
		}

		why = (outcome as { "why": string }).why;

		if (Date.now() >= deadline) {
			throw new TimeoutError(`${what}: timeout ${String(timeout)}ms exceeded — ${why}`);
		}

		await new Promise((resolve) => {
			setTimeout(resolve, Math.min(BACKOFF[Math.min(attempt, BACKOFF.length - 1)], Math.max(0, deadline - Date.now())));
		});
	}
}

interface RoleOptions { "name"?: Text; "exact"?: boolean; "checked"?: boolean; "disabled"?: boolean; "expanded"?: boolean; "includeHidden"?: boolean; "level"?: number; "pressed"?: boolean; "selected"?: boolean }
interface FilterOptions { "hasText"?: Text; "hasNotText"?: Text; "has"?: Locator; "hasNot"?: Locator; "visible"?: boolean }
interface ActionOptions { "timeout"?: number; "force"?: boolean }

/** What finds locators — a page, or a locator within which to look. */
abstract class Finder {
	protected abstract readonly driver: Driver;
	protected abstract readonly page: Page;
	protected abstract readonly steps: Step[];
	protected abstract readonly description: string;

	/** A locator `steps` further on, described as `more` further. */
	protected abstract further(steps: Step[], more: string): Locator;

	public locator(selector: string | Locator, options: FilterOptions = {}): Locator {
		const steps = typeof selector === "string" ? [{ "kind": "css", "selector": selector } as Step] : selector.steps;
		const more = typeof selector === "string" ? `locator(${JSON.stringify(selector)})` : `locator(${selector.description})`;
		const filtered = filterStep(options);

		return this.further(filtered === undefined ? steps : [...steps, filtered], more);
	}

	public getByRole(role: string, options: RoleOptions = {}): Locator {
		const { name, ...rest } = options;

		return this.further([{ "kind": "role", "role": role, ...rest, ...name === undefined ? {} : { "name": textMatch(name) } }], `getByRole(${JSON.stringify(role)}${name === undefined ? "" : `, { name: ${shown(name)} }`})`);
	}

	public getByText(text: Text, options: { "exact"?: boolean } = {}): Locator {
		return this.further([{ "kind": "text", "text": textMatch(text), ...options }], `getByText(${shown(text)})`);
	}

	public getByLabel(text: Text, options: { "exact"?: boolean } = {}): Locator {
		return this.further([{ "kind": "label", "text": textMatch(text), ...options }], `getByLabel(${shown(text)})`);
	}

	public getByPlaceholder(text: Text, options: { "exact"?: boolean } = {}): Locator {
		return this.further([{ "kind": "placeholder", "text": textMatch(text), ...options }], `getByPlaceholder(${shown(text)})`);
	}

	public getByAltText(text: Text, options: { "exact"?: boolean } = {}): Locator {
		return this.further([{ "kind": "altText", "text": textMatch(text), ...options }], `getByAltText(${shown(text)})`);
	}

	public getByTitle(text: Text, options: { "exact"?: boolean } = {}): Locator {
		return this.further([{ "kind": "title", "text": textMatch(text), ...options }], `getByTitle(${shown(text)})`);
	}

	public getByTestId(id: Text): Locator {
		return this.further([{ "kind": "testId", "id": textMatch(id) }], `getByTestId(${shown(id)})`);
	}
}

function filterStep(options: FilterOptions): Step | undefined {
	const { hasText, hasNotText, has, hasNot, visible } = options;

	if (hasText === undefined && hasNotText === undefined && has === undefined && hasNot === undefined && visible === undefined) {
		return undefined;
	}

	return {
		"kind": "filter",
		...hasText === undefined ? {} : { "hasText": textMatch(hasText) },
		...hasNotText === undefined ? {} : { "hasNotText": textMatch(hasNotText) },
		...has === undefined ? {} : { "has": has.steps },
		...hasNot === undefined ? {} : { "hasNot": hasNot.steps },
		...visible === undefined ? {} : { "visible": visible }
	};
}

/** Playwright's Page: where locators start, and how it's navigated. */
export class Page extends Finder {
	protected readonly page: Page = this;
	protected readonly steps: Step[] = [];
	protected readonly description = "page";
	/** How long an action or a wait takes before it fails (Playwright's `setDefaultTimeout`). */
	public timeout = 5000;
	protected readonly driver: Driver;

	public constructor(driver: Driver) {
		super();
		this.driver = driver;
	}

	protected further(steps: Step[], more: string): Locator {
		return new Locator(this.driver, this, steps, more);
	}

	public setDefaultTimeout(timeout: number): void {
		this.timeout = timeout;
	}

	public async goto(url: string): Promise<void> {
		if (this.driver.goto === undefined) {
			throw new Error("page.goto: this page can't be navigated");
		}

		await this.driver.goto(url);
	}

	public async url(): Promise<string> {
		return this.driver.url === undefined ? "" : this.driver.url();
	}

	public async title(): Promise<string> {
		return this.driver.title === undefined ? "" : this.driver.title();
	}

	public async waitForTimeout(ms: number): Promise<void> {
		await new Promise((resolve) => {
			setTimeout(resolve, ms);
		});
	}
}

/** Playwright's Locator: a way to find elements on a page, and what can be done with what it finds. */
export class Locator extends Finder {
	protected readonly driver: Driver;
	protected readonly page: Page;
	public readonly steps: Step[];
	public readonly description: string;

	public constructor(driver: Driver, page: Page, steps: Step[], description: string) {
		super();
		this.driver = driver;
		this.page = page;
		this.steps = steps;
		this.description = description;
	}

	protected further(steps: Step[], more: string): Locator {
		return new Locator(this.driver, this.page, [...this.steps, ...steps], `${this.description}.${more}`);
	}

	public override toString(): string {
		return this.description;
	}

	public first(): Locator {
		return this.further([{ "kind": "nth", "index": 0 }], "first()");
	}

	public last(): Locator {
		return this.further([{ "kind": "nth", "index": -1 }], "last()");
	}

	public nth(index: number): Locator {
		return this.further([{ "kind": "nth", "index": index }], `nth(${String(index)})`);
	}

	public filter(options: FilterOptions): Locator {
		const step = filterStep(options);

		return step === undefined ? this : this.further([step], "filter(…)");
	}

	/** Ask once (no waiting): an answer that's true now, or not (isVisible, count…). */
	private async now(action: Action, args: unknown[] = []): Promise<unknown> {
		const outcome = await this.driver.run({ "steps": this.steps, "action": action, "args": args });

		if ("error" in outcome) {
			throw new Error(`${this.description}.${action}: ${outcome.error}`);
		}

		return outcome.done ? outcome.value : undefined;
	}

	/** Ask until it's done: an action, or a read that needs its element there. */
	private async waited(action: Action, args: unknown[] = [], options: ActionOptions = {}): Promise<unknown> {
		return untilDone(this.driver, { "steps": this.steps, "action": action, "args": args, ...options.force === undefined ? {} : { "force": options.force } }, options.timeout ?? this.page.timeout, `${this.description}.${action}`);
	}

	public async count(): Promise<number> {
		return await this.now("count") as number;
	}

	public async all(): Promise<Locator[]> {
		return Array.from({ "length": await this.count() }, (_, index) => this.nth(index));
	}

	public async allTextContents(): Promise<string[]> {
		return await this.now("allTextContents") as string[];
	}

	public async allInnerTexts(): Promise<string[]> {
		return await this.now("allInnerTexts") as string[];
	}

	public async isVisible(): Promise<boolean> {
		return await this.now("isVisible") === true;
	}

	public async isHidden(): Promise<boolean> {
		return await this.now("isHidden") !== false;
	}

	public async isEnabled(options: ActionOptions = {}): Promise<boolean> {
		return await this.waited("isEnabled", [], options) as boolean;
	}

	public async isDisabled(options: ActionOptions = {}): Promise<boolean> {
		return await this.waited("isDisabled", [], options) as boolean;
	}

	public async isChecked(options: ActionOptions = {}): Promise<boolean> {
		return await this.waited("isChecked", [], options) as boolean;
	}

	/** Whether it has focus (for expect's toBeFocused). */
	public async isFocused(options: ActionOptions = {}): Promise<boolean> {
		return await this.waited("isFocused", [], options) as boolean;
	}

	public async isEditable(options: ActionOptions = {}): Promise<boolean> {
		return await this.waited("isEditable", [], options) as boolean;
	}

	public async textContent(options: ActionOptions = {}): Promise<string | null> {
		return await this.waited("textContent", [], options) as string | null;
	}

	public async innerText(options: ActionOptions = {}): Promise<string> {
		return await this.waited("innerText", [], options) as string;
	}

	public async innerHTML(options: ActionOptions = {}): Promise<string> {
		return await this.waited("innerHTML", [], options) as string;
	}

	public async inputValue(options: ActionOptions = {}): Promise<string> {
		return await this.waited("inputValue", [], options) as string;
	}

	public async getAttribute(name: string, options: ActionOptions = {}): Promise<string | null> {
		return await this.waited("getAttribute", [name], options) as string | null;
	}

	public async boundingBox(options: ActionOptions = {}): Promise<{ "x": number; "y": number; "width": number; "height": number } | null> {
		return await this.waited("boundingBox", [], options) as { "x": number; "y": number; "width": number; "height": number } | null;
	}

	public async click(options: ActionOptions = {}): Promise<void> {
		await this.waited("click", [], options);
	}

	public async dblclick(options: ActionOptions = {}): Promise<void> {
		await this.waited("dblclick", [], options);
	}

	public async hover(options: ActionOptions = {}): Promise<void> {
		await this.waited("hover", [], options);
	}

	public async focus(options: ActionOptions = {}): Promise<void> {
		await this.waited("focus", [], options);
	}

	public async blur(options: ActionOptions = {}): Promise<void> {
		await this.waited("blur", [], options);
	}

	public async fill(value: string, options: ActionOptions = {}): Promise<void> {
		await this.waited("fill", [value], options);
	}

	public async clear(options: ActionOptions = {}): Promise<void> {
		await this.waited("clear", [], options);
	}

	public async press(key: string, options: ActionOptions = {}): Promise<void> {
		await this.waited("press", [key], options);
	}

	public async pressSequentially(text: string, options: ActionOptions = {}): Promise<void> {
		await this.waited("pressSequentially", [text], options);
	}

	public async check(options: ActionOptions = {}): Promise<void> {
		await this.waited("check", [], options);
	}

	public async uncheck(options: ActionOptions = {}): Promise<void> {
		await this.waited("uncheck", [], options);
	}

	public async setChecked(checked: boolean, options: ActionOptions = {}): Promise<void> {
		await this.waited(checked ? "check" : "uncheck", [], options);
	}

	public async selectOption(values: string | string[] | { "value"?: string; "label"?: string; "index"?: number } | Array<{ "value"?: string; "label"?: string; "index"?: number }>, options: ActionOptions = {}): Promise<string[]> {
		return await this.waited("selectOption", [values], options) as string[];
	}

	public async dispatchEvent(type: string, init: Record<string, unknown> = {}, options: ActionOptions = {}): Promise<void> {
		await this.waited("dispatchEvent", [type, init], options);
	}

	public async scrollIntoViewIfNeeded(options: ActionOptions = {}): Promise<void> {
		await this.waited("scrollIntoViewIfNeeded", [], options);
	}

	public async waitFor(options: { "state"?: "attached" | "detached" | "visible" | "hidden"; "timeout"?: number } = {}): Promise<void> {
		await untilDone(this.driver, { "steps": this.steps, "action": "waitFor", "args": [{ "state": options.state ?? "visible" }] }, options.timeout ?? this.page.timeout, `${this.description}.waitFor`);
	}
}

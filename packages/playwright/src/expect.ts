/**
 * Playwright's `expect`: of a locator, assertions that ask again until they hold or their timeout passes (toBeVisible,
 * toHaveText…); of any other value, the plain ones a test file uses beside them (toBe, toEqual…). Each has `.not`.
 */
import { Locator, TimeoutError } from "./locator.ts";

type Text = string | RegExp;

/** How long a locator's assertion keeps asking (Playwright's expect timeout). */
export const EXPECT_TIMEOUT = 5000;

const normalized = (text: string): string => text.replaceAll(/\s+/gu, " ").trim();

/** Deep equality for toEqual: the same primitives, arrays of equal items, objects with equal own enumerable entries,
 *  dates and RegExps by value. (Not node:util's, so the package runs where Node's modules aren't.) */
function deepEqual(one: unknown, other: unknown): boolean {
	if (Object.is(one, other)) {
		return true;
	}

	if (typeof one !== "object" || typeof other !== "object" || one === null || other === null || Object.getPrototypeOf(one) !== Object.getPrototypeOf(other)) {
		return false;
	}

	if (one instanceof Date || one instanceof RegExp) {
		return String(one) === String(other);
	}

	const keys = Object.keys(one);

	return keys.length === Object.keys(other).length && keys.every((key) => deepEqual((one as Record<string, unknown>)[key], (other as Record<string, unknown>)[key]));
}

/** `text` as an assertion matches it: a RegExp tests it; a string is it (or with `contains`, is in it), whitespace collapsed. */
function textMatches(text: string, expected: Text, contains: boolean): boolean {
	if (typeof expected !== "string") {
		return expected.test(text);
	}

	return contains ? normalized(text).includes(normalized(expected)) : normalized(text) === normalized(expected);
}

/** An expected text as the failure says it: a string quoted, a RegExp as written. */
const shown = (expected: Text): string => (typeof expected === "string" ? JSON.stringify(expected) : String(expected));

class AssertionError extends Error {
	public override name = "AssertionError";
}

interface Options { "timeout"?: number }

/** A locator's assertions, waiting; `negated` for `.not`. */
class LocatorAssertions {
	private readonly locator: Locator;
	private readonly negated: boolean;

	public constructor(locator: Locator, negated = false) {
		this.locator = locator;
		this.negated = negated;
	}

	public get not(): LocatorAssertions {
		return new LocatorAssertions(this.locator, !this.negated);
	}

	/** Ask `read` until `holds(value)` is what's expected (not, for `.not`), or the timeout passes: then fail, saying what
	 *  was last read. */
	private async poll<T>(name: string, read: () => Promise<T>, holds: (value: T) => boolean, expected: string, options: Options = {}): Promise<void> {
		const deadline = Date.now() + (options.timeout ?? EXPECT_TIMEOUT);
		let last: T | undefined;
		let failure: unknown;

		for (;;) {
			try {
				last = await read();
				failure = undefined;

				if (holds(last) !== this.negated) {
					return;
				}
			} catch (error) {
				// (a strict-mode violation won't fix itself: say so at once)
				if (!(error instanceof TimeoutError) && /strict mode violation/u.test(String(error))) {
					throw error;
				}

				failure = error;
			}

			if (Date.now() >= deadline) {
				const received = failure === undefined ? JSON.stringify(last) : String(failure);

				throw new AssertionError(`expect(${this.locator.description}).${this.negated ? "not." : ""}${name}(${expected}) failed — received ${received}`);
			}

			await new Promise((resolve) => {
				setTimeout(resolve, 100);
			});
		}
	}

	private quick = { "timeout": 0 };

	public async toBeVisible(options?: Options): Promise<void> {
		await this.poll("toBeVisible", async () => this.locator.isVisible(), (value) => value, "", options);
	}

	public async toBeHidden(options?: Options): Promise<void> {
		await this.poll("toBeHidden", async () => this.locator.isHidden(), (value) => value, "", options);
	}

	public async toBeAttached(options?: Options): Promise<void> {
		await this.poll("toBeAttached", async () => this.locator.count(), (count) => count > 0, "", options);
	}

	public async toBeEnabled(options?: Options): Promise<void> {
		await this.poll("toBeEnabled", async () => this.locator.isEnabled(this.quick), (value) => value, "", options);
	}

	public async toBeDisabled(options?: Options): Promise<void> {
		await this.poll("toBeDisabled", async () => this.locator.isDisabled(this.quick), (value) => value, "", options);
	}

	public async toBeEditable(options?: Options): Promise<void> {
		await this.poll("toBeEditable", async () => this.locator.isEditable(this.quick), (value) => value, "", options);
	}

	public async toBeChecked(options: Options & { "checked"?: boolean } = {}): Promise<void> {
		const want = options.checked ?? true;

		await this.poll("toBeChecked", async () => this.locator.isChecked(this.quick), (value) => value === want, want ? "" : "{ checked: false }", options);
	}

	public async toBeFocused(options?: Options): Promise<void> {
		await this.poll("toBeFocused", async () => this.locator.isFocused(this.quick), (value) => value, "", options);
	}

	public async toHaveCount(count: number, options?: Options): Promise<void> {
		await this.poll("toHaveCount", async () => this.locator.count(), (value) => value === count, String(count), options);
	}

	/** Its text is `expected` (with an array, the texts of everything it finds, one for one). */
	public async toHaveText(expected: Text | Text[], options: Options & { "useInnerText"?: boolean } = {}): Promise<void> {
		await this.texts("toHaveText", expected, false, options);
	}

	public async toContainText(expected: Text | Text[], options: Options & { "useInnerText"?: boolean } = {}): Promise<void> {
		await this.texts("toContainText", expected, true, options);
	}

	private async texts(name: string, expected: Text | Text[], contains: boolean, options: Options & { "useInnerText"?: boolean }): Promise<void> {
		const read = async (): Promise<string[]> => (Array.isArray(expected) ? (options.useInnerText === true ? this.locator.allInnerTexts() : this.locator.allTextContents()) : [options.useInnerText === true ? await this.locator.innerText(this.quick) : await this.locator.textContent(this.quick) ?? ""]);
		const wanted = Array.isArray(expected) ? expected : [expected];

		await this.poll(name, read, (texts) => texts.length === wanted.length && texts.every((text, index) => textMatches(text, wanted[index], contains)), Array.isArray(expected) ? `[${wanted.map(shown).join(", ")}]` : shown(expected), options);
	}

	public async toHaveValue(expected: Text, options?: Options): Promise<void> {
		await this.poll("toHaveValue", async () => this.locator.inputValue(this.quick), (value) => (typeof expected === "string" ? value === expected : expected.test(value)), shown(expected), options);
	}

	public async toHaveAttribute(name: string, expected?: Text, options?: Options): Promise<void> {
		await this.poll("toHaveAttribute", async () => this.locator.getAttribute(name, this.quick), (value) => (expected === undefined ? value !== null : value !== null && (typeof expected === "string" ? value === expected : expected.test(value))), expected === undefined ? JSON.stringify(name) : `${JSON.stringify(name)}, ${shown(expected)}`, options);
	}

	public async toHaveClass(expected: Text, options?: Options): Promise<void> {
		await this.poll("toHaveClass", async () => this.locator.getAttribute("class", this.quick), (value) => (typeof expected === "string" ? normalized(value ?? "") === normalized(expected) : expected.test(value ?? "")), shown(expected), options);
	}

	public async toHaveId(expected: Text, options?: Options): Promise<void> {
		await this.poll("toHaveId", async () => this.locator.getAttribute("id", this.quick), (value) => (typeof expected === "string" ? value === expected : expected.test(value ?? "")), shown(expected), options);
	}
}

/** A plain value's assertions, at once. */
class ValueAssertions {
	private readonly actual: unknown;
	private readonly negated: boolean;

	public constructor(actual: unknown, negated = false) {
		this.actual = actual;
		this.negated = negated;
	}

	public get not(): ValueAssertions {
		return new ValueAssertions(this.actual, !this.negated);
	}

	private check(holds: boolean, name: string, expected: unknown = ""): void {
		if (holds === this.negated) {
			throw new AssertionError(`expect(${JSON.stringify(this.actual)}).${this.negated ? "not." : ""}${name}(${expected === "" ? "" : JSON.stringify(expected)}) failed`);
		}
	}

	public toBe(expected: unknown): void {
		this.check(Object.is(this.actual, expected), "toBe", expected);
	}

	public toEqual(expected: unknown): void {
		this.check(deepEqual(this.actual, expected), "toEqual", expected);
	}

	public toStrictEqual(expected: unknown): void {
		this.check(deepEqual(this.actual, expected), "toStrictEqual", expected);
	}

	public toBeTruthy(): void {
		this.check(Boolean(this.actual), "toBeTruthy");
	}

	public toBeFalsy(): void {
		this.check(!this.actual, "toBeFalsy");
	}

	public toBeDefined(): void {
		this.check(this.actual !== undefined, "toBeDefined");
	}

	public toBeUndefined(): void {
		this.check(this.actual === undefined, "toBeUndefined");
	}

	public toBeNull(): void {
		this.check(this.actual === null, "toBeNull");
	}

	public toContain(expected: unknown): void {
		this.check(typeof this.actual === "string" ? this.actual.includes(String(expected)) : Array.isArray(this.actual) && this.actual.includes(expected), "toContain", expected);
	}

	public toHaveLength(expected: number): void {
		this.check((this.actual as { "length"?: number } | null)?.length === expected, "toHaveLength", expected);
	}

	public toMatch(expected: Text): void {
		this.check(typeof this.actual === "string" && (typeof expected === "string" ? this.actual.includes(expected) : expected.test(this.actual)), "toMatch", String(expected));
	}

	public toBeGreaterThan(expected: number): void {
		this.check((this.actual as number) > expected, "toBeGreaterThan", expected);
	}

	public toBeGreaterThanOrEqual(expected: number): void {
		this.check((this.actual as number) >= expected, "toBeGreaterThanOrEqual", expected);
	}

	public toBeLessThan(expected: number): void {
		this.check((this.actual as number) < expected, "toBeLessThan", expected);
	}

	public toBeLessThanOrEqual(expected: number): void {
		this.check((this.actual as number) <= expected, "toBeLessThanOrEqual", expected);
	}
}

export function expect(actual: Locator): LocatorAssertions;
export function expect(actual: unknown): ValueAssertions;
export function expect(actual: unknown): LocatorAssertions | ValueAssertions {
	return actual instanceof Locator ? new LocatorAssertions(actual) : new ValueAssertions(actual);
}

/**
 * Our locators against Playwright's own, in Chromium: each case is one Playwright call made on both — on a real Playwright
 * page, and on our Page, whose driver runs our engine inside that same page — and they must find the same elements.
 * Then our actions and expect, which Playwright's semantics are the target of, on the same fixture.
 *
 *   node --test packages/playwright/test/engine.test.mjs
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { after, before, test } from "node:test";

import { launchChromium } from "@brianjenkins94/util/playwright/chromium";

const { Page, expect, TimeoutError } = await import("../src/index.ts");

const FIXTURE = fs.readFileSync(new URL("fixture.html", import.meta.url), "utf8");
// The engine as a page script: its types stripped, its exports plain functions, then handed to the page.
const ENGINE = stripTypeScriptTypes(fs.readFileSync(new URL("../src/engine.ts", import.meta.url), "utf8")).replaceAll(/^export /gmu, "") + "\nwindow.__engine = { run, resolve, roleOf, nameOf };";

let browser;
let page;
let ours;

/** The fixture, fresh, every element numbered (data-i) so both sides can name what they found. */
async function fresh() {
	await page.setContent(FIXTURE);
	await page.addScriptTag({ "content": ENGINE });
	await page.evaluate(() => {
		for (const [index, element] of [...document.querySelectorAll("*")].entries()) {
			element.dataset.i = String(index);
		}
	});
}

before(async () => {
	browser = await launchChromium({});
	page = await browser.newPage();
	ours = new Page({ "run": async (op) => page.evaluate((each) => globalThis.__engine.run(document, each), op) });
	await fresh();
});

after(async () => {
	await browser?.close();
});

const found = async (locator) => (locator.evaluateAll === undefined ? page.evaluate((steps) => globalThis.__engine.resolve(document, steps).map((element) => element.dataset.i), locator.steps) : locator.evaluateAll((elements) => elements.map((element) => element.dataset.i)));

/** One Playwright call, made on both sides. */
const CASES = {
	"css": (p) => p.locator("button"),
	"css, chained": (p) => p.locator("form").locator("input"),
	"role button": (p) => p.getByRole("button"),
	"role button, name": (p) => p.getByRole("button", { "name": "Save" }),
	"role button, exact name": (p) => p.getByRole("button", { "name": "Save", "exact": true }),
	"role button, name regex": (p) => p.getByRole("button", { "name": /^save/iu }),
	"role button, aria-label": (p) => p.getByRole("button", { "name": "Close dialog" }),
	"role button, labelledby": (p) => p.getByRole("button", { "name": "Labelled by two" }),
	"role button, input value": (p) => p.getByRole("button", { "name": "Send" }),
	"role button, default submit": (p) => p.getByRole("button", { "name": "Submit" }),
	"role button, pressed": (p) => p.getByRole("button", { "pressed": true }),
	"role button, expanded false": (p) => p.getByRole("button", { "expanded": false }),
	"role button, disabled": (p) => p.getByRole("button", { "disabled": true }),
	"role button, include hidden": (p) => p.getByRole("button", { "name": /^Hidden/u, "includeHidden": true }),
	"role link": (p) => p.getByRole("link"),
	"role link, name": (p) => p.getByRole("link", { "name": "Cart" }),
	"role heading": (p) => p.getByRole("heading"),
	"role heading, level 2": (p) => p.getByRole("heading", { "level": 2 }),
	"role heading, level 4": (p) => p.getByRole("heading", { "level": 4 }),
	"role textbox": (p) => p.getByRole("textbox"),
	"role textbox, label": (p) => p.getByRole("textbox", { "name": "Email address" }),
	"role textbox, placeholder name": (p) => p.getByRole("textbox", { "name": "Only a placeholder" }),
	"role searchbox": (p) => p.getByRole("searchbox"),
	"role checkbox": (p) => p.getByRole("checkbox"),
	"role checkbox, checked": (p) => p.getByRole("checkbox", { "checked": true }),
	"role checkbox, name": (p) => p.getByRole("checkbox", { "name": "Subscribe" }),
	"role radio, name": (p) => p.getByRole("radio", { "name": "Pro" }),
	"role combobox": (p) => p.getByRole("combobox"),
	"role listbox": (p) => p.getByRole("listbox"),
	"role option, selected": (p) => p.getByRole("option", { "selected": true }),
	"role group, legend": (p) => p.getByRole("group", { "name": "Plan" }),
	"role navigation": (p) => p.getByRole("navigation", { "name": "Main" }),
	"role region": (p) => p.getByRole("region"),
	"role form": (p) => p.getByRole("form", { "name": "Sign in" }),
	"role banner, main, contentinfo": (p) => p.getByRole("main"),
	"role list, listitem": (p) => p.getByRole("listitem"),
	"role img": (p) => p.getByRole("img"),
	"role img, name": (p) => p.getByRole("img", { "name": "A red apple" }),
	"role table, caption": (p) => p.getByRole("table", { "name": "Prices" }),
	"role cell": (p) => p.getByRole("cell"),
	"role columnheader": (p) => p.getByRole("columnheader"),
	"role rowheader": (p) => p.getByRole("rowheader"),
	"role dialog": (p) => p.getByRole("dialog", { "name": "Notice" }),
	"role progressbar": (p) => p.getByRole("progressbar", { "name": "Loading" }),
	"text": (p) => p.getByText("Hello"),
	"text, across children": (p) => p.getByText("Hello world"),
	"text, case-insensitive": (p) => p.getByText("case sensitive"),
	"text, exact": (p) => p.getByText("Case Sensitive", { "exact": true }),
	"text, exact miss": (p) => p.getByText("case sensitive", { "exact": true }),
	"text, whitespace": (p) => p.getByText("Spaced out text"),
	"text, regex": (p) => p.getByText(/^Footer/u),
	"text, input value": (p) => p.getByText("Click me"),
	"label": (p) => p.getByLabel("Email address"),
	"label, wrapping": (p) => p.getByLabel("Password"),
	"label, aria-label": (p) => p.getByLabel("Notes"),
	"label, checkbox": (p) => p.getByLabel("Remember me"),
	"placeholder": (p) => p.getByPlaceholder("you@example.com"),
	"alt text": (p) => p.getByAltText("A red apple"),
	"title": (p) => p.getByTitle("Your cart"),
	"test id": (p) => p.getByTestId("product-card"),
	"nth, first, last": (p) => p.getByRole("listitem").nth(1),
	"first": (p) => p.getByRole("listitem").first(),
	"last": (p) => p.getByRole("listitem").last(),
	"filter, hasText": (p) => p.getByTestId("product-card").filter({ "hasText": "Pears" }),
	"filter, hasNotText": (p) => p.getByTestId("product-card").filter({ "hasNotText": "Pears" }),
	"filter, has": (p) => p.getByTestId("product-card").filter({ "has": p.getByRole("heading", { "name": "Apples" }) }),
	"filter, visible": (p) => p.getByTestId("product-card").filter({ "visible": true }),
	"chained role in test id": (p) => p.getByTestId("product-card").getByRole("button", { "name": "Add to cart" }),
	"locator with hasText": (p) => p.locator("div", { "hasText": "Apples" })
};

/** The test of one case: what Playwright finds, we find. */
const agrees = (make) => async () => {
	const theirs = await found(make(page));
	const mine = await found(make(ours));

	assert.deepEqual(mine, theirs, `ours ${JSON.stringify(mine)}, Playwright's ${JSON.stringify(theirs)}`);
};

for (const [name, make] of Object.entries(CASES)) {
	test(`finds as Playwright does: ${name}`, agrees(make));
}

test("states, as Playwright reads them", async () => {
	for (const [name, make, read] of [
		["visible", (p) => p.getByRole("button", { "name": "Save", "exact": true }), (l) => l.isVisible()],
		["hidden by display", (p) => p.locator("button", { "hasText": "Hidden by display" }), (l) => l.isVisible()],
		["hidden by visibility", (p) => p.locator("button", { "hasText": "Hidden by visibility" }), (l) => l.isVisible()],
		["disabled", (p) => p.getByRole("button", { "name": "Disabled save" }), (l) => l.isDisabled()],
		["disabled by fieldset", (p) => p.getByLabel("Locked field"), (l) => l.isDisabled()],
		["checked", (p) => p.getByLabel("Remember me"), (l) => l.isChecked()],
		["aria-checked", (p) => p.getByRole("checkbox", { "name": "Custom check" }), (l) => l.isChecked()],
		["editable", (p) => p.getByLabel("Email address"), (l) => l.isEditable()],
		["read-only", (p) => p.getByLabel("Read only"), (l) => l.isEditable()],
		["text content", (p) => p.getByRole("button", { "name": "Labelled by two" }), (l) => l.textContent()],
		["input value", (p) => p.getByLabel("Read only"), (l) => l.inputValue()],
		["count", (p) => p.getByTestId("product-card"), (l) => l.count()]
	]) {
		assert.deepEqual(await read(make(ours)), await read(make(page)), name);
	}
});

test("actions: fill, check, select, click, press Enter submits", async () => {
	await fresh();
	await page.evaluate(() => {
		globalThis.submitted = 0;
		document.getElementById("signin").addEventListener("submit", (event) => {
			event.preventDefault();
			globalThis.submitted += 1;
		});
		globalThis.inputs = 0;
		document.getElementById("email").addEventListener("input", () => {
			globalThis.inputs += 1;
		});
	});

	await ours.getByLabel("Email address").fill("ada@example.com");
	assert.equal(await page.getByLabel("Email address").inputValue(), "ada@example.com");
	assert.ok(await page.evaluate(() => globalThis.inputs) >= 1, "input fired");

	await ours.getByLabel("Subscribe").check();
	assert.equal(await page.getByLabel("Subscribe").isChecked(), true);
	await ours.getByLabel("Remember me").uncheck();
	assert.equal(await page.getByLabel("Remember me").isChecked(), false);

	assert.deepEqual(await ours.getByLabel("Size").selectOption("Large"), ["Large"]);
	assert.equal(await page.getByLabel("Size").inputValue(), "Large");

	await ours.getByRole("radio", { "name": "Pro" }).check();
	assert.equal(await page.getByRole("radio", { "name": "Pro" }).isChecked(), true);

	await ours.getByLabel("Email address").press("Enter");
	assert.equal(await page.evaluate(() => globalThis.submitted), 1, "Enter in a field submits its form");

	await ours.getByPlaceholder("Only a placeholder").pressSequentially("abc");
	assert.equal(await page.getByPlaceholder("Only a placeholder").inputValue(), "abc");
	await ours.getByPlaceholder("Only a placeholder").press("Backspace");
	assert.equal(await page.getByPlaceholder("Only a placeholder").inputValue(), "ab");
});

test("waiting: an action waits for its element; strictness and covering are said", async () => {
	await fresh();
	ours.setDefaultTimeout(2000);

	// Appears later: the click waits for it.
	await page.evaluate(() => {
		setTimeout(() => {
			const button = document.getElementById("late").content.firstElementChild.cloneNode(true);

			button.addEventListener("click", () => {
				button.textContent = "Clicked";
			});
			document.body.append(button);
		}, 300);
	});
	await ours.getByRole("button", { "name": "Late button" }).click();
	await expect(ours.getByRole("button", { "name": "Clicked" })).toBeVisible();

	await assert.rejects(ours.getByRole("button", { "name": "Add to cart" }).click(), /strict mode violation: it resolved to 2 elements/u);
	await assert.rejects(ours.getByRole("button", { "name": "Under the cover" }).click({ "timeout": 300 }), (error) => error instanceof TimeoutError && /is on top of/u.test(error.message));
	await assert.rejects(ours.getByRole("button", { "name": "Nothing like it" }).click({ "timeout": 300 }), /no element matches/u);
});

test("expect: waits until it holds, and .not", async () => {
	await fresh();
	await page.evaluate(() => {
		setTimeout(() => {
			document.querySelector("h1").textContent = "Shop (3)";
		}, 300);
	});

	await expect(ours.getByRole("heading", { "level": 1 })).toHaveText("Shop (3)");
	await expect(ours.getByRole("heading", { "level": 1 })).toContainText("(3)");
	await expect(ours.getByRole("listitem")).toHaveCount(3);
	await expect(ours.getByRole("listitem")).toHaveText(["One", "Two", "Three"]);
	await expect(ours.getByLabel("Read only")).toHaveValue("fixed");
	await expect(ours.getByRole("link", { "name": "Cart" })).toHaveAttribute("href", "/cart");
	await expect(ours.getByLabel("Remember me")).toBeChecked();
	await expect(ours.getByRole("button", { "name": "Disabled save" })).toBeDisabled();
	await expect(ours.locator("button", { "hasText": "Hidden by display" })).toBeHidden();
	await expect(ours.getByText("Nothing like it")).not.toBeVisible();
	await assert.rejects(expect(ours.getByRole("heading", { "level": 1 })).toHaveText("Wrong", { "timeout": 300 }), /toHaveText\("Wrong"\) failed — received \["Shop \(3\)"\]/u);
	expect(3).toBe(3);
	expect({ "a": [1] }).toEqual({ "a": [1] });
	expect("abc").not.toContain("z");
});

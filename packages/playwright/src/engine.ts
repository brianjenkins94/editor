/**
 * The DOM side of the editor's Playwright: a locator's steps resolved against a document, the state of what they find,
 * and the actions done to it — run where the DOM is (the shell, in a preview's frame), never through a protocol. Its
 * target is Playwright's documented behaviour: text matched as a substring, case-insensitively and with whitespace
 * collapsed unless `exact`; elements hidden from assistive technology left out of role queries; one element for an
 * action (strict); an action waiting until its element can take it (attached, visible, enabled, not covered).
 *
 * `run(document, op)` answers an op once: done (with its value), not yet (why — the caller waits and asks again, as
 * Playwright's auto-waiting does) or an error that waiting won't fix. Everything an op carries is plain data, so it
 * crosses realms and the hub: a RegExp as its source and flags.
 */

/** A text to match: a string, or a RegExp as its source and flags. */
export type TextMatch = string | { "source": string; "flags": string };

/** One step of a locator: what it finds within what the steps before it found (the document, first). */
export type Step =
	| { "kind": "css"; "selector": string }
	| { "kind": "role"; "role": string; "name"?: TextMatch; "exact"?: boolean; "checked"?: boolean; "disabled"?: boolean; "expanded"?: boolean; "includeHidden"?: boolean; "level"?: number; "pressed"?: boolean; "selected"?: boolean }
	| { "kind": "text" | "label" | "placeholder" | "altText" | "title"; "text": TextMatch; "exact"?: boolean }
	| { "kind": "testId"; "id": TextMatch }
	| { "kind": "nth"; "index": number }
	| { "kind": "filter"; "hasText"?: TextMatch; "hasNotText"?: TextMatch; "has"?: Step[]; "hasNot"?: Step[]; "visible"?: boolean };

/** What to do with what a locator finds. */
export interface Op {
	"steps": Step[];
	"action": Action;
	"args"?: unknown[];
	/** Act even if it isn't visible, enabled or reachable (Playwright's `force`). */
	"force"?: boolean;
}

export type Action =
	| "count" | "allTextContents" | "allInnerTexts"
	| "textContent" | "innerText" | "innerHTML" | "inputValue" | "getAttribute" | "boundingBox"
	| "isVisible" | "isHidden" | "isEnabled" | "isDisabled" | "isChecked" | "isEditable" | "isFocused"
	| "click" | "dblclick" | "hover" | "focus" | "blur" | "fill" | "clear" | "press" | "pressSequentially"
	| "check" | "uncheck" | "selectOption" | "dispatchEvent" | "scrollIntoViewIfNeeded" | "waitFor";

/** An op's answer: its value; not yet, and why; or an error waiting won't fix. */
export type Outcome = { "done": true; "value"?: unknown } | { "done": false; "why": string } | { "error": string };

const NOT_TEXT = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD"]);

// ── matching text ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Whitespace collapsed to single spaces, and trimmed — as Playwright compares text. */
function normalized(text: string): string {
	return text.replaceAll(/\s+/gu, " ").trim();
}

/** Whether `text` matches: a RegExp tests it; a string is contained in it, case-insensitively, or with `exact`, is it. */
function matches(text: string, match: TextMatch, exact = false): boolean {
	const value = normalized(text);

	if (typeof match !== "string") {
		return new RegExp(match.source, match.flags.replace("g", "")).test(value);
	}

	return exact ? value === normalized(match) : value.toLowerCase().includes(normalized(match).toLowerCase());
}

/** An element's text as Playwright reads it for text matching: its descendants' text, a button-like input's value,
 *  scripts and styles left out. */
function elementText(element: Element): string {
	if (element.tagName === "INPUT" && ["button", "submit", "reset"].includes((element as HTMLInputElement).type)) {
		return (element as HTMLInputElement).value;
	}

	let text = "";

	for (const child of element.childNodes) {
		if (child.nodeType === 3) {
			text += child.nodeValue ?? "";
		} else if (child.nodeType === 1 && !NOT_TEXT.has((child as Element).tagName)) {
			text += elementText(child as Element);
		}
	}

	return text;
}

// ── visibility and state ─────────────────────────────────────────────────────────────────────────────────────────────

const windowOf = (element: Element): Window & typeof globalThis => element.ownerDocument.defaultView as Window & typeof globalThis;

/** Playwright's visible: a non-empty box, and not `visibility: hidden` (an element with `display: contents` is visible
 *  when a child is). */
export function isVisible(element: Element): boolean {
	const style = windowOf(element).getComputedStyle(element);

	if (style.display === "contents") {
		return [...element.children].some(isVisible);
	}

	if (style.visibility === "hidden" || style.visibility === "collapse") {
		return false;
	}

	const box = element.getBoundingClientRect();

	return box.width > 0 && box.height > 0;
}

/** Hidden from assistive technology: not rendered (display: none or hidden up the tree), `visibility: hidden`, or under
 *  `aria-hidden="true"`. */
function hiddenForAria(element: Element): boolean {
	for (let at: Element | null = element; at !== null; at = at.parentElement) {
		if (at.getAttribute("aria-hidden") === "true") {
			return true;
		}
	}

	const style = windowOf(element).getComputedStyle(element);

	if (style.visibility === "hidden" || style.visibility === "collapse") {
		return true;
	}

	// (checkVisibility is false for anything in a display: none subtree; an <option> renders through its <select>)
	const check = (element as Element & { "checkVisibility"?: () => boolean }).checkVisibility;

	return element.tagName !== "OPTION" && check !== undefined && !check.call(element);
}

const DISABLEABLE = new Set(["BUTTON", "INPUT", "SELECT", "TEXTAREA", "OPTION", "OPTGROUP", "FIELDSET"]);

/** Disabled: natively (the element, an enclosing disabled <fieldset> outside its first <legend>, an <option>'s
 *  disabled <optgroup>) or by `aria-disabled="true"` on it or above it. */
export function isDisabled(element: Element): boolean {
	if (DISABLEABLE.has(element.tagName) && element.hasAttribute("disabled")) {
		return true;
	}

	for (let at = element.parentElement; at !== null; at = at.parentElement) {
		if (DISABLEABLE.has(element.tagName) && at.tagName === "FIELDSET" && at.hasAttribute("disabled") && !at.querySelector(":scope > legend")?.contains(element)) {
			return true;
		}

		if (element.tagName === "OPTION" && at.tagName === "OPTGROUP" && at.hasAttribute("disabled")) {
			return true;
		}
	}

	for (let at: Element | null = element; at !== null; at = at.parentElement) {
		if (at.getAttribute("aria-disabled") === "true") {
			return true;
		}
	}

	return false;
}

const TEXT_INPUTS = new Set(["", "text", "search", "url", "tel", "email", "password", "number", "date", "datetime-local", "month", "week", "time", "color"]);

/** Editable: enabled, not read-only, and something that takes text — an input that does, a textarea, a select, or
 *  content-editable. */
export function isEditable(element: Element): boolean {
	if (isDisabled(element) || element.hasAttribute("readonly") || element.getAttribute("aria-readonly") === "true") {
		return false;
	}

	if (element.tagName === "INPUT") {
		return TEXT_INPUTS.has((element as HTMLInputElement).type);
	}

	return element.tagName === "TEXTAREA" || element.tagName === "SELECT" || (element as HTMLElement).isContentEditable;
}

/** Checked: a checkbox's or radio's, or `aria-checked` ("mixed" counts as checked); undefined when it can't be. */
export function checkedOf(element: Element): boolean | undefined {
	if (element.tagName === "INPUT" && ["checkbox", "radio"].includes((element as HTMLInputElement).type)) {
		return (element as HTMLInputElement).checked;
	}

	const aria = element.getAttribute("aria-checked");

	return aria === null ? undefined : aria === "true" || aria === "mixed";
}

// ── roles and accessible names ───────────────────────────────────────────────────────────────────────────────────────

const INPUT_ROLES: Record<string, string> = { "button": "button", "submit": "button", "reset": "button", "image": "button", "checkbox": "checkbox", "radio": "radio", "range": "slider", "number": "spinbutton", "search": "searchbox", "email": "textbox", "tel": "textbox", "text": "textbox", "url": "textbox", "password": "textbox", "": "textbox" };
const SECTIONING = "article, aside, main, nav, section";

/** An element's role: its `role` attribute's first token, else the one HTML gives it (the common ones). */
export function roleOf(element: Element): string | undefined {
	const explicit = element.getAttribute("role")?.trim().split(/\s+/u)[0];

	if (explicit !== undefined && explicit !== "") {
		return explicit;
	}

	const tag = element.tagName;
	const named = (): boolean => element.hasAttribute("aria-label") || element.hasAttribute("aria-labelledby") || element.hasAttribute("title");

	switch (tag) {
		case "A": case "AREA": return element.hasAttribute("href") ? "link" : undefined;
		case "BUTTON": case "SUMMARY": return "button";
		case "INPUT": {
			const input = element as HTMLInputElement;

			if (input.type === "hidden" || input.type === "file") {
				return undefined;
			}

			return input.hasAttribute("list") && ["", "text", "search", "email", "tel", "url"].includes(input.type) ? "combobox" : INPUT_ROLES[input.type] ?? "textbox";
		}
		case "TEXTAREA": return "textbox";
		case "SELECT": return (element as HTMLSelectElement).multiple || (element as HTMLSelectElement).size > 1 ? "listbox" : "combobox";
		case "OPTION": return "option";
		case "IMG": return element.getAttribute("alt") === "" && !named() ? "presentation" : "img";
		case "H1": case "H2": case "H3": case "H4": case "H5": case "H6": return "heading";
		case "UL": case "OL": case "MENU": return "list";
		case "LI": return "listitem";
		case "NAV": return "navigation";
		case "MAIN": return "main";
		case "ASIDE": return "complementary";
		case "HEADER": return element.closest(SECTIONING) === null || element.closest(SECTIONING) === element ? "banner" : undefined;
		case "FOOTER": return element.closest(SECTIONING) === null || element.closest(SECTIONING) === element ? "contentinfo" : undefined;
		case "SECTION": return named() ? "region" : undefined;
		case "FORM": return named() ? "form" : undefined;
		case "ARTICLE": return "article";
		case "DIALOG": return "dialog";
		case "FIELDSET": return "group";
		case "TABLE": return "table";
		case "TR": return "row";
		case "TD": return "cell";
		case "TH": return element.closest("thead") !== null || element.getAttribute("scope") === "col" ? "columnheader" : "rowheader";
		case "HR": return "separator";
		case "PROGRESS": return "progressbar";
		case "METER": return "meter";
		case "P": return "paragraph";
		case "DL": return "list";
		default: return undefined;
	}
}

/** Roles whose name comes from their content when nothing names them (WAI-ARIA's "name from: contents"). */
const NAME_FROM_CONTENT = new Set(["button", "cell", "checkbox", "columnheader", "gridcell", "heading", "link", "listitem", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "radio", "row", "rowheader", "switch", "tab", "tooltip", "treeitem"]);

/** A subtree's text for a name: text nodes, an image's alt, a named element's name, hidden parts left out, a space
 *  around what renders as a block. */
function contentName(element: Element, includeHidden: boolean): string {
	let text = "";

	for (const child of element.childNodes) {
		if (child.nodeType === 3) {
			text += child.nodeValue ?? "";
			continue;
		}

		if (child.nodeType !== 1 || NOT_TEXT.has((child as Element).tagName)) {
			continue;
		}

		const each = child as Element;

		if (!includeHidden && hiddenForAria(each)) {
			continue;
		}

		const label = each.getAttribute("aria-label")?.trim();
		const part = label !== undefined && label !== "" ? label : each.tagName === "IMG" ? each.getAttribute("alt") ?? "" : contentName(each, includeHidden);
		const display = windowOf(each).getComputedStyle(each).display;

		text += display.startsWith("inline") ? part : ` ${part} `;
	}

	return text;
}

/** An element's accessible name, the common parts of the computation: aria-labelledby, aria-label, a control's labels,
 *  an image's alt, a button-like input's value, a fieldset's legend, a table's caption, its content (for the roles
 *  named from it), its title, and a text field's placeholder last. */
export function nameOf(element: Element, includeHidden = false): string {
	const document = element.ownerDocument;
	const labelledBy = element.getAttribute("aria-labelledby")?.trim();

	if (labelledBy !== undefined && labelledBy !== "") {
		const named = labelledBy.split(/\s+/u).map((id) => document.getElementById(id)).filter((each) => each !== null).map((each) => normalized(each.getAttribute("aria-label") ?? contentName(each, true)));

		if (named.join("") !== "") {
			return normalized(named.join(" "));
		}
	}

	const label = element.getAttribute("aria-label")?.trim();

	if (label !== undefined && label !== "") {
		return normalized(label);
	}

	const tag = element.tagName;

	if (tag === "INPUT" && ["button", "submit", "reset"].includes((element as HTMLInputElement).type)) {
		const input = element as HTMLInputElement;

		return normalized(input.value !== "" || input.hasAttribute("value") ? input.value : input.type === "submit" ? "Submit" : input.type === "reset" ? "Reset" : "");
	}

	if (tag === "INPUT" && (element as HTMLInputElement).type === "image" || tag === "IMG" || tag === "AREA") {
		const alt = element.getAttribute("alt");

		if (alt !== null) {
			return normalized(alt);
		}
	}

	const labels = (element as HTMLInputElement).labels;

	if (labels !== undefined && labels !== null && labels.length > 0) {
		return normalized([...labels].map((each) => contentName(each, includeHidden)).join(" "));
	}

	if (tag === "FIELDSET") {
		const legend = element.querySelector(":scope > legend");

		if (legend !== null) {
			return normalized(contentName(legend, includeHidden));
		}
	}

	if (tag === "TABLE") {
		const caption = element.querySelector(":scope > caption");

		if (caption !== null) {
			return normalized(contentName(caption, includeHidden));
		}
	}

	const role = roleOf(element);

	if (role !== undefined && NAME_FROM_CONTENT.has(role)) {
		const content = normalized(contentName(element, includeHidden));

		if (content !== "") {
			return content;
		}
	}

	const title = element.getAttribute("title");

	if (title !== null && title.trim() !== "") {
		return normalized(title);
	}

	return normalized(element.getAttribute("placeholder") ?? "");
}

/** A heading's level: an h1–h6's own (its aria-level doesn't change it, as in Playwright), else its aria-level. */
function headingLevel(element: Element): number | undefined {
	if (/^H[1-6]$/u.test(element.tagName)) {
		return Number(element.tagName[1]);
	}

	const aria = Number(element.getAttribute("aria-level"));

	return Number.isInteger(aria) && aria > 0 ? aria : undefined;
}

function selectedOf(element: Element): boolean | undefined {
	if (element.tagName === "OPTION") {
		return (element as HTMLOptionElement).selected;
	}

	const aria = element.getAttribute("aria-selected");

	return aria === null ? undefined : aria === "true";
}

/** Whether `element` is what a role step asks for. */
function roleMatches(element: Element, step: Extract<Step, { "kind": "role" }>): boolean {
	if (roleOf(element) !== step.role || (step.includeHidden !== true && hiddenForAria(element))) {
		return false;
	}

	if (step.checked !== undefined && checkedOf(element) !== step.checked) {
		return false;
	}

	if (step.disabled !== undefined && isDisabled(element) !== step.disabled) {
		return false;
	}

	// (without aria-expanded it's neither expanded nor collapsed: `expanded: false` doesn't find it)
	if (step.expanded !== undefined && (element.getAttribute("aria-expanded") === null || (element.getAttribute("aria-expanded") === "true") !== step.expanded)) {
		return false;
	}

	if (step.pressed !== undefined && (element.getAttribute("aria-pressed") === "true") !== step.pressed) {
		return false;
	}

	if (step.selected !== undefined && selectedOf(element) !== step.selected) {
		return false;
	}

	if (step.level !== undefined && headingLevel(element) !== step.level) {
		return false;
	}

	return step.name === undefined || matches(nameOf(element, step.includeHidden === true), step.name, step.exact);
}

/** A form control's label texts: aria-labelledby's, aria-label, and its <label>s'. */
function labelTexts(element: Element): string[] {
	const texts: string[] = [];
	const document = element.ownerDocument;

	for (const id of element.getAttribute("aria-labelledby")?.trim().split(/\s+/u) ?? []) {
		const each = id === "" ? null : document.getElementById(id);

		if (each !== null) {
			texts.push(elementText(each));
		}
	}

	const label = element.getAttribute("aria-label");

	if (label !== null) {
		texts.push(label);
	}

	for (const each of (element as HTMLInputElement).labels ?? []) {
		texts.push(elementText(each));
	}

	return texts;
}

// ── resolving steps ──────────────────────────────────────────────────────────────────────────────────────────────────

type Scope = Document | Element;

/** Every element within `scope`, in document order. */
function within(scope: Scope): Element[] {
	return [...scope.querySelectorAll("*")];
}

/** What a text step finds: the elements whose text matches and none of whose child elements' does — the smallest that
 *  holds the text, as Playwright's getByText. */
function byText(scope: Scope, text: TextMatch, exact: boolean | undefined): Element[] {
	return within(scope).filter((element) => !NOT_TEXT.has(element.tagName) && element.closest("head") === null && matches(elementText(element), text, exact) && ![...element.children].some((child) => matches(elementText(child), text, exact)));
}

function stepFrom(scopes: Scope[], step: Step): Element[] {
	const found = new Set<Element>();
	const add = (elements: Iterable<Element>): void => {
		for (const each of elements) {
			found.add(each);
		}
	};

	for (const scope of scopes) {
		switch (step.kind) {
			case "css": add(scope.querySelectorAll(step.selector)); break;
			case "role": add(within(scope).filter((element) => roleMatches(element, step))); break;
			case "text": add(byText(scope, step.text, step.exact)); break;
			case "label": add(within(scope).filter((element) => labelTexts(element).some((text) => matches(text, step.text, step.exact)))); break;
			case "placeholder": add(within(scope).filter((element) => element.hasAttribute("placeholder") && matches(element.getAttribute("placeholder") ?? "", step.text, step.exact))); break;
			case "altText": add(within(scope).filter((element) => element.hasAttribute("alt") && matches(element.getAttribute("alt") ?? "", step.text, step.exact))); break;
			case "title": add(within(scope).filter((element) => element.hasAttribute("title") && matches(element.getAttribute("title") ?? "", step.text, step.exact))); break;
			case "testId": add(within(scope).filter((element) => element.hasAttribute("data-testid") && matches(element.getAttribute("data-testid") ?? "", step.id, true))); break;
			default: break;
		}
	}

	// (in document order, as a selector's matches are, whichever scope found them)
	return [...found].sort((one, other) => (one === other ? 0 : one.compareDocumentPosition(other) & 4 ? -1 : 1));
}

/** The elements `steps` find from `scopes`, in document order: each step within what the one before found. */
function resolveFrom(scopes: Scope[], steps: Step[]): Element[] {
	let current: Element[] | undefined;

	for (const step of steps) {
		if (step.kind === "nth") {
			const list = current ?? [];
			const at = step.index < 0 ? list.length + step.index : step.index;

			current = at >= 0 && at < list.length ? [list[at]] : [];
		} else if (step.kind === "filter") {
			current = (current ?? []).filter((element) => (step.hasText === undefined || matches(elementText(element), step.hasText))
				&& (step.hasNotText === undefined || !matches(elementText(element), step.hasNotText))
				&& (step.has === undefined || resolveFrom([element], step.has).length > 0)
				&& (step.hasNot === undefined || resolveFrom([element], step.hasNot).length === 0)
				&& (step.visible === undefined || isVisible(element) === step.visible));
		} else {
			current = stepFrom(current ?? scopes, step);
		}
	}

	return current ?? [];
}

/** The elements `steps` find in `document` (a filter's `has` finds them inside the element it filters). */
export function resolve(document: Document, steps: Step[]): Element[] {
	return resolveFrom([document], steps);
}

// ── acting ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** An element as an error names it: its tag, id and classes, and the start of its text. */
export function describe(element: Element): string {
	const id = element.id === "" ? "" : `#${element.id}`;
	const classes = [...element.classList].slice(0, 2).map((each) => "." + each).join("");
	const text = normalized(elementText(element)).slice(0, 40);

	return `<${element.tagName.toLowerCase()}${id}${classes}>${text === "" ? "" : ` "${text}"`}`;
}

/** Why `element` can't take a pointer action now, or undefined when it can: it isn't visible, it's disabled, or
 *  something else is on top of its middle. Scrolled into view first. */
function notActionable(element: Element, needsEnabled: boolean): string | undefined {
	if (!isVisible(element)) {
		return `${describe(element)} isn't visible`;
	}

	if (needsEnabled && isDisabled(element)) {
		return `${describe(element)} is disabled`;
	}

	element.scrollIntoView({ "block": "center", "inline": "center" });

	const box = element.getBoundingClientRect();
	const hit = element.ownerDocument.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);

	if (hit !== null && hit !== element && !element.contains(hit)) {
		return `${describe(hit)} is on top of ${describe(element)}`;
	}

	return undefined;
}

function pointer(element: Element, types: string[], detail = 1): void {
	const view = windowOf(element);
	const box = element.getBoundingClientRect();
	const init = { "bubbles": true, "cancelable": true, "composed": true, "clientX": box.left + box.width / 2, "clientY": box.top + box.height / 2, "button": 0, "detail": detail, "view": view };

	for (const type of types) {
		const event = type.startsWith("pointer") ? new view.PointerEvent(type, { ...init, "pointerType": "mouse", "isPrimary": true }) : new view.MouseEvent(type, init);

		element.dispatchEvent(event);

		if (type === "mousedown" && (element as HTMLElement).focus !== undefined) {
			(element.closest("[tabindex], a[href], button, input, select, textarea, [contenteditable='true']") as HTMLElement | null)?.focus();
		}
	}
}

/** Set a form control's value as typing would, so a framework watching the element sees it: through its prototype's
 *  setter (React tracks the instance's), then input and change. */
function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
	const view = windowOf(element);
	const prototype = element.tagName === "TEXTAREA" ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;

	Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
	element.dispatchEvent(new view.InputEvent("input", { "bubbles": true, "composed": true, "inputType": "insertText", "data": value }));
	element.dispatchEvent(new view.Event("change", { "bubbles": true }));
}

/** A key as Playwright names it (`Enter`, `a`, `Control+a`, `Shift+Tab`): the key, and its modifiers. */
function parseKey(combo: string): { "key": string; "ctrlKey": boolean; "shiftKey": boolean; "altKey": boolean; "metaKey": boolean } {
	const parts = combo === "+" ? ["+"] : combo.split("+");
	const key = parts.at(-1) ?? "";
	const has = (name: string): boolean => parts.slice(0, -1).includes(name);

	return { "key": key, "ctrlKey": has("Control") || has("ControlOrMeta"), "shiftKey": has("Shift"), "altKey": has("Alt"), "metaKey": has("Meta") };
}

/** Press one key on `element` (focused): keydown, the key's effect unless prevented — a character typed, Backspace,
 *  Enter submitting a field's form or breaking a textarea's line, select-all — then keyup. */
function pressKey(element: Element, combo: string): void {
	const view = windowOf(element);
	const parsed = parseKey(combo);
	const init = { ...parsed, "bubbles": true, "cancelable": true, "composed": true, "code": parsed.key.length === 1 ? `Key${parsed.key.toUpperCase()}` : parsed.key, "view": view };
	const field = element.tagName === "INPUT" || element.tagName === "TEXTAREA" ? element as HTMLInputElement | HTMLTextAreaElement : undefined;
	const proceed = element.dispatchEvent(new view.KeyboardEvent("keydown", init));
	const modified = parsed.ctrlKey || parsed.metaKey || parsed.altKey;

	if (proceed && field !== undefined) {
		const start = field.selectionStart ?? field.value.length;
		const end = field.selectionEnd ?? field.value.length;

		if (parsed.key.length === 1 && !modified) {
			if (element.dispatchEvent(new view.KeyboardEvent("keypress", init))) {
				setValue(field, field.value.slice(0, start) + parsed.key + field.value.slice(end));
				field.setSelectionRange(start + 1, start + 1);
			}
		} else if (parsed.key === "Backspace") {
			const from = start === end ? Math.max(0, start - 1) : start;

			setValue(field, field.value.slice(0, from) + field.value.slice(end));
			field.setSelectionRange(from, from);
		} else if (parsed.key === "Enter") {
			if (field.tagName === "TEXTAREA") {
				setValue(field, field.value.slice(0, start) + "\n" + field.value.slice(end));
			} else {
				field.form?.requestSubmit();
			}
		} else if (parsed.key.toLowerCase() === "a" && (parsed.ctrlKey || parsed.metaKey)) {
			field.select();
		}
	} else if (proceed && parsed.key === "Enter" && ["BUTTON", "A"].includes(element.tagName)) {
		(element as HTMLElement).click();
	}

	element.dispatchEvent(new view.KeyboardEvent("keyup", init));
}

/** Choose a select's options by value or label (or index): the ones chosen, by value. */
function selectOptions(select: HTMLSelectElement, wanted: unknown[]): string[] | string {
	const options = [...select.options];
	const chosen = wanted.map((want) => options.find((option, index) => (typeof want === "string" ? option.value === want || normalized(option.label) === normalized(want) : typeof want === "object" && want !== null && (("value" in want && option.value === want.value) || ("label" in want && option.label === want.label) || ("index" in want && index === want.index)))));

	if (chosen.some((option) => option === undefined)) {
		return `no option ${JSON.stringify(wanted[chosen.indexOf(undefined)])} in ${describe(select)}`;
	}

	if (!select.multiple && chosen.length > 1) {
		return `${describe(select)} takes one option, not ${String(chosen.length)}`;
	}

	for (const option of options) {
		option.selected = chosen.includes(option);
	}

	const view = windowOf(select);

	select.dispatchEvent(new view.Event("input", { "bubbles": true, "composed": true }));
	select.dispatchEvent(new view.Event("change", { "bubbles": true }));

	return chosen.map((option) => (option as HTMLOptionElement).value);
}

const POINTER_ACTIONS = new Set<Action>(["click", "dblclick", "hover", "check", "uncheck"]);
const MANY = new Set<Action>(["count", "allTextContents", "allInnerTexts", "waitFor"]);

/** Answer `op` once in `document` (see the header). */
export function run(document: Document, op: Op): Outcome {
	const found = resolve(document, op.steps);
	const args = op.args ?? [];

	if (MANY.has(op.action)) {
		switch (op.action) {
			case "count": return { "done": true, "value": found.length };
			case "allTextContents": return { "done": true, "value": found.map((element) => element.textContent ?? "") };
			case "allInnerTexts": return { "done": true, "value": found.map((element) => (element as HTMLElement).innerText ?? "") };
			default: {
				// waitFor({ state }): attached, detached, visible (the default) or hidden
				const state = (args[0] as { "state"?: string } | undefined)?.state ?? "visible";
				const ok = state === "attached" ? found.length > 0 : state === "detached" ? found.length === 0 : state === "visible" ? found.some(isVisible) : !found.some(isVisible);

				return ok ? { "done": true } : { "done": false, "why": `waiting for it to be ${state}` };
			}
		}
	}

	// (one element for everything else — Playwright's strictness; `isVisible` and its kin answer for none too)
	if (found.length > 1) {
		return { "error": `strict mode violation: it resolved to ${String(found.length)} elements: ${found.slice(0, 5).map(describe).join(", ")}${found.length > 5 ? ", …" : ""}` };
	}

	const element = found[0];

	if (element === undefined) {
		if (op.action === "isVisible" || op.action === "isChecked" || op.action === "isEditable" || op.action === "isEnabled" || op.action === "isFocused") {
			return op.action === "isVisible" ? { "done": true, "value": false } : { "done": false, "why": "no element matches" };
		}

		if (op.action === "isHidden") {
			return { "done": true, "value": true };
		}

		return { "done": false, "why": "no element matches" };
	}

	switch (op.action) {
		case "textContent": return { "done": true, "value": element.textContent };
		case "innerText": return { "done": true, "value": (element as HTMLElement).innerText };
		case "innerHTML": return { "done": true, "value": element.innerHTML };
		case "getAttribute": return { "done": true, "value": element.getAttribute(String(args[0])) };
		case "boundingBox": {
			if (!isVisible(element)) {
				return { "done": true, "value": null };
			}

			const box = element.getBoundingClientRect();

			return { "done": true, "value": { "x": box.x, "y": box.y, "width": box.width, "height": box.height } };
		}
		case "inputValue": {
			if (!["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)) {
				return { "error": `${describe(element)} isn't an <input>, <textarea> or <select>` };
			}

			return { "done": true, "value": (element as HTMLInputElement).value };
		}
		case "isVisible": return { "done": true, "value": isVisible(element) };
		case "isHidden": return { "done": true, "value": !isVisible(element) };
		case "isEnabled": return { "done": true, "value": !isDisabled(element) };
		case "isDisabled": return { "done": true, "value": isDisabled(element) };
		case "isEditable": return { "done": true, "value": isEditable(element) };
		case "isFocused": return { "done": true, "value": element.ownerDocument.activeElement === element };
		case "isChecked": {
			const checked = checkedOf(element);

			return checked === undefined ? { "error": `${describe(element)} isn't a checkbox or radio` } : { "done": true, "value": checked };
		}
		default: break;
	}

	if (POINTER_ACTIONS.has(op.action) && op.force !== true) {
		const why = notActionable(element, op.action !== "hover");

		if (why !== undefined) {
			return { "done": false, "why": why };
		}
	}

	switch (op.action) {
		case "click": pointer(element, ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]); return { "done": true };
		case "dblclick": {
			pointer(element, ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
			pointer(element, ["pointerdown", "mousedown", "pointerup", "mouseup", "click"], 2);
			pointer(element, ["dblclick"], 2);

			return { "done": true };
		}
		case "hover": pointer(element, ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]); return { "done": true };
		case "check":
		case "uncheck": {
			const want = op.action === "check";
			const before = checkedOf(element);

			if (before === undefined) {
				return { "error": `${describe(element)} isn't a checkbox or radio` };
			}

			if (before !== want) {
				pointer(element, ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
			}

			return checkedOf(element) === want ? { "done": true } : { "error": `clicking ${describe(element)} didn't ${op.action} it` };
		}
		case "focus": (element as HTMLElement).focus(); return { "done": true };
		case "blur": (element as HTMLElement).blur(); return { "done": true };
		case "scrollIntoViewIfNeeded": element.scrollIntoView({ "block": "center", "inline": "center" }); return { "done": true };
		case "dispatchEvent": {
			const view = windowOf(element);

			element.dispatchEvent(new view.Event(String(args[0]), { "bubbles": true, "cancelable": true, "composed": true, ...args[1] as object }));

			return { "done": true };
		}
		case "fill":
		case "clear": {
			const value = op.action === "clear" ? "" : String(args[0]);

			if (element.tagName === "INPUT" && !TEXT_INPUTS.has((element as HTMLInputElement).type)) {
				return { "error": `${describe(element)} (type ${(element as HTMLInputElement).type}) can't be filled` };
			}

			if (op.force !== true && (!isVisible(element) || !isEditable(element))) {
				return { "done": false, "why": `${describe(element)} isn't ${isVisible(element) ? "editable" : "visible"}` };
			}

			(element as HTMLElement).focus();

			if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
				setValue(element as HTMLInputElement, value);
			} else if ((element as HTMLElement).isContentEditable) {
				element.textContent = value;
				element.dispatchEvent(new (windowOf(element).InputEvent)("input", { "bubbles": true, "composed": true, "inputType": "insertText", "data": value }));
			} else {
				return { "error": `${describe(element)} isn't an <input>, <textarea> or content-editable` };
			}

			return { "done": true };
		}
		case "press":
		case "pressSequentially": {
			(element as HTMLElement).focus();

			for (const key of op.action === "press" ? [String(args[0])] : [...String(args[0])]) {
				pressKey(element, key);
			}

			return { "done": true };
		}
		case "selectOption": {
			if (element.tagName !== "SELECT") {
				return { "error": `${describe(element)} isn't a <select>` };
			}

			if (op.force !== true && (!isVisible(element) || isDisabled(element))) {
				return { "done": false, "why": `${describe(element)} isn't ${isVisible(element) ? "enabled" : "visible"}` };
			}

			const chosen = selectOptions(element as HTMLSelectElement, Array.isArray(args[0]) ? args[0] : [args[0]]);

			return typeof chosen === "string" ? { "done": false, "why": chosen } : { "done": true, "value": chosen };
		}
		default: return { "error": `no action ${op.action}` };
	}
}

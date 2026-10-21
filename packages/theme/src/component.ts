/**
 * theme/component — a composed component as a function (PLAN.md §10): its options, its slots as arrays and its
 * handlers in, the element out, made from the component's definition, the one declaration of what it takes and fires
 * (its custom-elements.json is derived from it, scripts/web-awesome.mjs).
 *
 *     export const appWindow = component(definition);
 *     appWindow({ "label": "Preview", "closable": true, "headerActions": [toolbar], "children": [body], "onClose": close });
 *
 * - An attribute is its camelCased name: `true` sets it, `false` or none leaves it off, anything else is its value.
 * - A named slot is an array (of nodes or strings) placed in one `<div slot="name">`, so a light-DOM component's grid
 *   and a Web Awesome element's shadow slot each take it whole (one element alone is given the slot itself, so the
 *   caller keeps it); the default slot is `children`, appended as they are.
 * - A handler is `on` and the event's name, its `app-` or `wa-` prefix dropped (`app-close` → `onClose`), so a caller
 *   needn't know which element fired it.
 *
 * The element comes back, for its properties and methods. In Preact or React, the element itself, in JSX, does the same.
 *
 * And `webAwesomeOr(tag)`: a Web Awesome element when it's registered, else its native counterpart (theme/web-awesome's
 * `natives`), so a component works without Web Awesome — plainer, styled by the same tokens.
 */
import { natives } from "./web-awesome";

export interface Definition {
	"tag": string;
	/** name → what it does */
	"attributes": Readonly<Record<string, string>>;
	/** name (`""` the default slot) → what goes in it */
	"slots": Readonly<Record<string, string>>;
	/** name → when it fires */
	"events": Readonly<Record<string, string>>;
}

export type Slot = readonly (Node | string)[];

type Camel<Name extends string> = Name extends `${infer Head}-${infer Tail}` ? `${Head}${Capitalize<Camel<Tail>>}` : Name;
type Handler<Name extends string> = `on${Capitalize<Camel<Name extends `app-${infer Rest}` | `wa-${infer Rest}` ? Rest : Name>>}`;

export type Options<Shape extends Definition> =
	{ [Name in keyof Shape["attributes"] & string as Camel<Name>]?: string | number | boolean }
	& { [Name in keyof Shape["slots"] & string as Name extends "" ? "children" : Camel<Name>]?: Slot }
	& { [Name in keyof Shape["events"] & string as Handler<Name>]?: (event: Event) => void };

const camel = (name: string) => name.replaceAll(/-(\w)/gu, (_, letter: string) => letter.toUpperCase());
const handler = (name: string) => "on" + camel(name.replace(/^(?:app|wa)-/u, "")).replace(/^\w/u, (letter) => letter.toUpperCase());

/** The element a tag makes: its class, where it's declared in `HTMLElementTagNameMap`. */
type Made<Tag extends string> = Tag extends keyof HTMLElementTagNameMap ? HTMLElementTagNameMap[Tag] : HTMLElement;

/** The function that makes `definition.tag` from options. */
export function component<Shape extends Definition>(definition: Shape) {
	return (options: Options<Shape> = {}): Made<Shape["tag"]> => {
		const given: Record<string, unknown> = options;
		const element = document.createElement(definition.tag) as Made<Shape["tag"]>;

		for (const name of Object.keys(definition.attributes)) {
			const value = given[camel(name)] as string | number | boolean | undefined;

			if (value !== undefined && value !== false) {
				element.setAttribute(name, value === true ? "" : String(value));
			}
		}

		for (const name of Object.keys(definition.slots)) {
			const nodes = given[name === "" ? "children" : camel(name)] as Slot | undefined;

			if (nodes !== undefined && name === "") {
				element.append(...nodes);
			} else if (nodes?.length === 1 && nodes[0] instanceof Element) {
				nodes[0].slot = name;
				element.append(nodes[0]);
			} else if (nodes !== undefined) {
				const holder = document.createElement("div");

				holder.slot = name;
				holder.append(...nodes);
				element.append(holder);
			}
		}

		for (const name of Object.keys(definition.events)) {
			const listener = given[handler(name)] as ((event: Event) => void) | undefined;

			if (listener !== undefined) {
				element.addEventListener(name, listener);
			}
		}

		return element;
	};
}

/** `tag`, a Web Awesome element, if it's registered; else its native counterpart. */
export function webAwesomeOr(tag: keyof typeof natives): HTMLElement {
	return document.createElement(customElements.get(tag) === undefined ? natives[tag] : tag);
}

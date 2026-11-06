/**
 * Rules as they're read and made (packages/editor/RUNNING.md, *Rules*), without the DOM: a rule as a sentence in the catalog's
 * words (describeRule: above each rule in its file, and on the call it decides), and what a rule about a call can cover
 * (scopesOf: what the picker offers).
 */
import type { Comparison, Compound, Predicate, Rule, Schema, Target } from "@brianjenkins94/util/silo/policy";

/** What rows and actions can say. */
export interface RuleCatalog {
	"targets": Record<string, Pick<Target, "label" | "type_id" | "description">>;
	/** Each type of target's operators, in the order offered. */
	"types": Record<string, string[]>;
	"operators": Record<string, { "label": string }>;
	/** Each action, and the targets it acts on (`give` process.argv); without, it takes none. */
	"actions": Record<string, { "label": string; "targets"?: string[] }>;
	/** A row's argument's schema; undefined: it takes none. */
	"argumentSchema": (targetId: string, operatorId: string) => Schema | undefined;
	/** An action's argument's schema, given its target; undefined: it takes none. */
	"actionSchema": (actionId: string, targetId?: string) => Schema | undefined;
}

const isCompound = (predicate: Predicate): predicate is Compound => "predicates" in predicate;

/** Arguments as a command line: each as typed, quoted when it has to be. */
export function joinCommandLine(args: unknown[]): string {
	return args.map((arg) => (typeof arg === "string" && arg !== "" && !/[\s"']/u.test(arg) ? arg : JSON.stringify(typeof arg === "string" ? arg : JSON.stringify(arg)))).join(" ");
}

/** A place in the code (a span reference: its file, and its tokens) as words: "tax.js: const rate = rates[country] ?? 0;". */
export function sayPlace(value: unknown): string {
	const { file, shape } = (value ?? {}) as { "file"?: string; "shape"?: { "atoms"?: string[] } };
	const code = (shape?.atoms ?? []).reduce((text, atom) => (text === "" || /^[;,.)\]}]/u.test(atom) || /[([{.]$/u.test(text) ? text + atom : `${text} ${atom}`), "");

	return `${file ?? "?"}: ${code.length > 60 ? `${code.slice(0, 59)}…` : code}`;
}

/** A value as a sentence says it: a command line as typed, a list's items, a string as is. */
function sayValue(schema: Schema | undefined, value: unknown): string {
	const object = typeof schema === "object" ? schema : {};

	if (object["format"] === "span") {
		return sayPlace(value);
	}

	if (Array.isArray(value)) {
		return object["format"] === "command-line" ? joinCommandLine(value) : value.map((each) => sayValue(object["items"] as Schema | undefined, each)).join(object["items"] !== undefined && typeof object["items"] === "object" && (object["items"] as Record<string, unknown>)["type"] === "array" ? " · " : ", ");
	}

	return typeof value === "string" ? value : JSON.stringify(value);
}

/** A rule as a sentence, in the catalog's words: "capability is fs:write and resource matches /workspace/** → allow". */
export function describeRule(rule: Rule, catalog: RuleCatalog): string {
	const say = (predicate: Predicate, nested: boolean): string => {
		if (!isCompound(predicate)) {
			const schema = catalog.argumentSchema(predicate.target_id, predicate.operator_id);

			return [catalog.targets[predicate.target_id]?.label ?? predicate.target_id, catalog.operators[predicate.operator_id]?.label ?? predicate.operator_id, ...schema === undefined ? [] : [sayValue(schema, predicate.argument)]].join(" ");
		}

		const parts = predicate.predicates.map((each) => say(each, true));
		const joined = parts.join(predicate.logicalType_id === "any" ? " or " : " and ");
		const said = predicate.logicalType_id === "none" ? `not (${parts.join(" or ")})` : joined;

		if (parts.length === 0) {
			return predicate.logicalType_id === "any" ? "never" : "always";
		}

		return nested && parts.length > 1 && predicate.logicalType_id !== "none" ? `(${said})` : said;
	};

	const actions = rule.then.map((action) => {
		const schema = catalog.actionSchema(action.action_id, action.target_id);

		return [catalog.actions[action.action_id]?.label ?? action.action_id, ...action.target_id === undefined ? [] : [catalog.targets[action.target_id]?.label ?? action.target_id], ...schema === undefined ? [] : [sayValue(schema, action.argument)]].join(" ");
	});

	return `${say(rule.when, false)} → ${actions.join(", then ")}`;
}

export type PolicyModule = typeof import("@brianjenkins94/util/silo/policy");

/** silo's catalog, as the rule editor takes it. */
export const catalogOf = (policy: PolicyModule): RuleCatalog => ({ "targets": policy.TARGETS, "types": policy.TYPES, "operators": policy.OPERATORS, "actions": policy.ACTIONS, "argumentSchema": policy.argumentSchema, "actionSchema": policy.actionSchema });

/** What a rule about a call can cover, narrowest first. */
export interface Scope { "label": string; "when": Compound }

/** The ways a rule can cover a call of `capability` on `resource` (none known: only every call of it): just this one; for a
 *  path each folder it's in, for an address its site, for a command every one of its program's; or every call of it. */
export function scopesOf(capability: string, resource?: string): Scope[] {
	const about = (...rows: Comparison[]): Compound => ({ "logicalType_id": "all", "predicates": [{ "target_id": "capability", "operator_id": "is", "argument": capability }, ...rows] });
	const glob = (argument: string): Scope => ({ "label": argument, "when": about({ "target_id": "resource", "operator_id": "matches", "argument": argument }) });
	const every: Scope = { "label": `Every ${capability} call`, "when": about() };

	if (resource === undefined || resource === "") {
		return [every];
	}

	return [{ "label": `Just ${resource}`, "when": about({ "target_id": "resource", "operator_id": "is", "argument": resource }) }, ...wider(resource).map(glob), every];
}

/** What's wider than `resource`, as globs. */
function wider(resource: string): string[] {
	if (resource.startsWith("/")) {
		const folders = resource.split("/").slice(1, -1);

		return folders.map((_, at) => `/${folders.slice(0, folders.length - at).join("/")}/**`);
	}

	if (/^[a-z][a-z\d+.-]*:\/\//iu.test(resource)) {
		return [`${new URL(resource).origin}/**`];
	}

	const [program, ...args] = resource.split(" ");

	return args.length === 0 ? [] : [`${program} **`];
}

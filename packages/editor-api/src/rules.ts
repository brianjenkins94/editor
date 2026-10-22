/**
 * Rules as they're read and edited (RULES.md), without the DOM: a rule as a sentence in the catalog's words
 * (describeRule — the Rules tree's rows), the catalog an edit offers (silo's, with a place's variables), and what a rule
 * being edited would do (verdictOf — said under it in the Rule view, and whether its buttons can act on it) — and what an
 * edit asks for (`editor.rules.edit`, EXTENSION-POINTS 5). The rule editor itself (its rows and inputs) is core's, in
 * the Rule view (workbench/rule-view.ts); this is what it and the capabilities extension share.
 *
 * Whoever asks for an edit says what the rule is judged against: a rule of the Rules tree's own (`rule`: described, or
 * why it matches nothing); a capability call (`call`: a preview's prompt, a debugger's stop — whether it covers the call,
 * and what it decides, or the result it gives); a program's `process.argv` (`argv`: the runs it gives); a variable at a
 * place (`place`: what it sets each time the program gets there).
 */
import type { Compound, Predicate, Rule, Schema, Target, Trigger } from "@brianjenkins94/util/silo/policy";

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

/** What a rule as edited would do: said under it, and whether its buttons can act on it. */
export interface Verdict { "text": string; "ok": boolean; "refused"?: boolean }

/** What the rule is judged against. */
export type Judge =
	| { "kind": "rule" }
	| { "kind": "call"; "capability": string; "resource"?: string; "package"?: string; "resolved"?: boolean; "canGive"?: boolean; "recorded"?: { "value": unknown; "at": string }; "trigger"?: Trigger }
	| { "kind": "argv"; "program": string }
	| { "kind": "place"; "program": string; "place": unknown; "variables": Record<string, unknown> };

/** A button under the rule: `always`, enabled whatever the verdict. */
export interface EditButton { "id": string; "label": string; "className": string; "title": string; "always"?: boolean }

/** An edit (`silo.rules.edit`): the rule as it starts (by default, for a call, one about it — startingRule), what it's
 *  judged against, the variables it may test or set (each with its latest value's kind), and its buttons. `id`: one edit
 *  with the same id asked again replaces it. */
export interface EditRequest { "id": string; "rule"?: Rule; "judge": Judge; "variables"?: { "name": string; "kind": string }[]; "buttons": EditButton[] }

/** The button pressed, and the rule as it was then — or null: closed, or replaced by another edit. */
export type EditAnswer = { "button": string; "rule": Rule } | null;

/** silo's catalog, as the rule editor takes it. */
export const catalogOf = (policy: PolicyModule): RuleCatalog => ({ "targets": policy.TARGETS, "types": policy.TYPES, "operators": policy.OPERATORS, "actions": policy.ACTIONS, "argumentSchema": policy.argumentSchema, "actionSchema": policy.actionSchema });

/** The schema of a value of a cell's kind — what a rule's input for it is drawn from. */
const schemaOfKind = (kind: string): Schema => (kind === "number" || kind === "string" || kind === "boolean" ? { "type": kind } : true);

/** silo's catalog, with `variables.<name>` for each variable (its latest value's kind): what a rule placed where they're
 *  in scope can test, and set. */
export function withVariables(policy: PolicyModule, values: { "name": string; "kind": string }[]): RuleCatalog {
	const base = catalogOf(policy);
	const variables = new Map(values.map(({ name, kind }) => [`variables.${name}`, { "name": name, "kind": kind }]));

	return {
		...base,
		"targets": { ...base.targets, ...Object.fromEntries([...variables].map(([id, { name, kind }]) => [id, { "label": name, "type_id": kind === "number" || kind === "boolean" ? kind : "string", "description": `The variable ${name}, where the rule is placed` }])) },
		"actions": { ...base.actions, "set": { ...base.actions["set"], "targets": [...variables.keys()] } },
		"argumentSchema": (targetId, operatorId) => (variables.has(targetId) ? policy.OPERATORS[operatorId]?.argument(schemaOfKind(variables.get(targetId).kind)) : base.argumentSchema(targetId, operatorId)),
		"actionSchema": (actionId, targetId) => (actionId === "set" && targetId !== undefined && variables.has(targetId) ? schemaOfKind(variables.get(targetId).kind) : base.actionSchema(actionId, targetId))
	};
}

/** The variables a rule tests or sets (`variables.<name>`), by name. */
export function variablesOf(rule: Rule): string[] {
	const names = new Set<string>();
	const walk = (predicate: Predicate): void => {
		if ("predicates" in predicate) {
			predicate.predicates.forEach(walk);
		} else if (predicate.target_id.startsWith("variables.")) {
			names.add(predicate.target_id.slice("variables.".length));
		}
	};

	walk(rule.when);

	for (const action of rule.then) {
		if (action.target_id?.startsWith("variables.") === true) {
			names.add(action.target_id.slice("variables.".length));
		}
	}

	return [...names];
}

/** The first allow / deny / skip / ask a rule has. */
export const decisionOf = (rule: Rule): string | undefined => rule.then.find(({ "action_id": actionId }) => ["allow", "deny", "skip", "ask"].includes(actionId))?.action_id;

/** The result a rule gives a call, when it gives one. */
export function resultOf(rule: Rule): { "value": unknown } | undefined {
	const give = rule.then.find((action) => action.action_id === "give" && action.target_id === "result");

	return give === undefined ? undefined : { "value": give.argument };
}

/** A rule about a call, as it starts: its capability, its resource (when known), the package making it (when it's a
 *  package's), then allow. */
export function callRule(capability: string, resource?: string, pkg?: string): Rule {
	return {
		"when": {
			"logicalType_id": "all",
			"predicates": [
				{ "target_id": "capability", "operator_id": "is", "argument": capability },
				...resource === undefined ? [] : [{ "target_id": "resource", "operator_id": "is", "argument": resource }],
				...pkg === undefined ? [] : [{ "target_id": "package", "operator_id": "is", "argument": pkg }]
			]
		},
		"then": [{ "action_id": "allow" }]
	};
}

/** The rule an edit starts with: the one asked for, else one about the call (callRule), else a row to fill in. */
export function startingRule(request: EditRequest): Rule {
	if (request.rule !== undefined) {
		return request.rule;
	}

	return request.judge.kind === "call" ? callRule(request.judge.capability, request.judge.resolved === false ? undefined : request.judge.resource, request.judge.package) : { "when": { "logicalType_id": "all", "predicates": [{ "target_id": "capability", "operator_id": "is", "argument": "" }] }, "then": [{ "action_id": "allow" }] };
}

/** What a rule that covers a call does to it: gives it a result (`gives`: only where something stands in for it), or
 *  decides it. */
function coversText(gives: boolean, canGive: boolean, decision: string | undefined): string {
	if (gives) {
		return canGive ? "Covers this call: gives it this result instead" : "A result can only be given in the debugger, where nothing real is called";
	}

	switch (decision ?? "") {
		case "allow":
			return "Covers this call: allows it";
		case "deny":
			return "Covers this call: denies it";
		case "skip":
			return "Covers this call: skips it";
		case "ask":
			return "Covers this call, and asks — as now";
		default:
			return "Covers this call, but doesn't decide it";
	}
}

/** What a rule as edited would do to a call: whether it covers it (`resolved`: what it reaches is known) and what it
 *  decides — ok when it allows, denies or skips it, or gives it a result where one can be given. */
function callVerdict(policy: PolicyModule, rule: Rule, judge: Extract<Judge, { "kind": "call" }>): Verdict {
	const subject = { "trigger": judge.trigger ?? "you", "capability": judge.capability, ...judge.resolved === false ? {} : { "resource": judge.resource }, ...judge.package === undefined ? {} : { "package": judge.package } };
	const problem = policy.problemOf(rule);
	const covers = problem === undefined && policy.ruleMatches(rule, subject);
	const decision = decisionOf(rule);
	const canGive = judge.canGive === true;
	// A result given instead of the call: only where something stands in for it (the debugger), not a real call.
	const gives = rule.then.some((action) => action.action_id === "give" && action.target_id === "result");
	const verdict: Verdict = {
		"text": problem ?? (!covers
			? `Doesn't cover this call${judge.resolved === false ? " — what it reaches isn't known before the line runs" : ""}`
			: coversText(gives, canGive, decision)),
		"ok": covers && (gives ? canGive : decision === "allow" || decision === "deny" || decision === "skip"),
		"refused": problem !== undefined
	};
	const { recorded } = judge;

	return recorded !== undefined && verdict.ok && JSON.stringify(resultOf(rule)?.value) === JSON.stringify(recorded.value) ? { ...verdict, "text": `Covers this call: gives it what it returned on ${new Date(recorded.at).toLocaleString()}` } : verdict;
}

/** The runs a rule on process.argv gives: each run's arguments. */
export function argvRunsOf(rule: Rule): string[][] {
	const give = rule.then.find((action) => action.action_id === "give" && action.target_id === "process.argv");

	return Array.isArray(give?.argument) ? (give.argument as unknown[]).filter((each): each is string[] => Array.isArray(each)) : [];
}

/** What a rule on process.argv's row would do to `program`: cover it, and give it `runs` runs' arguments. */
function argvText(program: string, covers: boolean, runs: number): string {
	if (!covers) {
		return `Doesn't cover ${program}`;
	}

	if (runs === 0) {
		return "Gives process.argv nothing";
	}

	return `Gives ${program} ${runs === 1 ? "these arguments" : `${runs} runs, one after another`}`;
}

/** The variables a rule sets at its place, and to what. */
export function setsOf(rule: Rule): { "name": string; "value": unknown }[] {
	return rule.then.filter((action) => action.action_id === "set" && action.target_id?.startsWith("variables.") === true).map((action) => ({ "name": action.target_id.slice("variables.".length), "value": action.argument }));
}

/** What a rule on a variable's row would do here: cover this place, and set `names`. */
function placeText(covers: boolean, names: string[]): string {
	if (!covers) {
		return "Doesn't cover this place, as the run is now";
	}

	return names.length === 0 ? "Sets nothing" : `Sets ${names.join(", ")} each time the program gets here`;
}

/** What `rule` as edited would do, judged as `judge` says — `describe` says a rule of the tree's own in words. */
export function verdictOf(policy: PolicyModule, rule: Rule, judge: Judge, describe: (rule: Rule) => string): Verdict {
	const problem = policy.problemOf(rule);

	switch (judge.kind) {
		case "call":
			return callVerdict(policy, rule, judge);
		case "argv": {
			const covers = problem === undefined && policy.ruleMatches(rule, { "program": judge.program });
			const runs = argvRunsOf(rule).length;

			return { "text": problem ?? argvText(judge.program, covers, runs), "ok": covers && runs > 0, "refused": problem !== undefined };
		}

		case "place": {
			const covers = problem === undefined && policy.ruleMatches(rule, { "program": judge.program, "at": judge.place, "variables": judge.variables });
			const names = setsOf(rule).map((each) => each.name);

			return { "text": problem ?? placeText(covers, names), "ok": covers && names.length > 0, "refused": problem !== undefined };
		}

		case "rule":
			return problem === undefined ? { "text": describe(rule), "ok": true } : { "text": problem, "ok": false, "refused": true };
		// no default
	}
}

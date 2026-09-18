/**
 * Capability policy — the PURE model (no vscode, no node, no oxc), shared by the panel (policy.ts, which adds the
 * vscode file I/O) and the RUNTIME enforcer (enforce.ts, which runs inside the almostnode worker where the program
 * actually executes). Keeping it dependency-free is what lets the exact same rules govern both "what the panel
 * shows" and "what the running program is allowed to do".
 */

/** A stored decision. `review` is never stored — it's the computed default for an undecided dangerous call. */
export type Disposition = "allow" | "deny";
/** The effective disposition shown in the UI (stored decision, or the computed default). */
export type Effective = Disposition | "review";

export interface Rule {
	"capability": string;
	"resource": string;
	"disposition": Disposition;
	/** ISO timestamp of when this decision was FIRST authorized (a user "Allow always"/"Deny always"). Immutable
	 *  across later disposition flips — it answers "which capabilities did I grant during window X" for a
	 *  retroactive compromise audit. Absent on hand-authored base rules; stamped on silo-written overrides. */
	"added"?: string;
}

export interface Policy {
	"version": number;
	"rules": Rule[];
}

export const EMPTY_POLICY: Policy = { "version": 1, "rules": [] };

/** Parse a policy file's text (`.silo/policy.json` or a `<user>.policy.json`), tolerating malformed input (→ empty policy). */
export function parsePolicy(text: string): Policy {
	try {
		const parsed = JSON.parse(text) as Partial<Policy>;

		return { "version": parsed.version ?? 1, "rules": Array.isArray(parsed.rules) ? parsed.rules : [] };
	} catch (error) {
		return { ...EMPTY_POLICY };
	}
}

/**
 * Whether a rule's resource matches an actual resource seen at a call. Exact match, OR the actual resource STARTS
 * WITH the rule's (so a `net` rule for `https://api.example.com` covers all its paths, and an `fs:write` rule for
 * `/tmp/` covers everything under it). The panel keys rules on exact observed resources; the runtime sees concrete
 * ones — prefix matching bridges the two without a full glob engine (that's a later refinement).
 */
export function matchesResource(ruleResource: string, actual: string): boolean {
	return actual === ruleResource || (ruleResource !== "" && actual.startsWith(ruleResource));
}

/** The first rule governing (capability, resource), or undefined. */
export function findRule(policy: Policy, capability: string, resource: string): Rule | undefined {
	return policy.rules.find((rule) => rule.capability === capability && matchesResource(rule.resource, resource));
}

/** The effective disposition for a call: an explicit rule wins; otherwise dangerous → review, safe → allow. */
export function effectiveDisposition(policy: Policy, capability: string, resource: string, dangerous: boolean): Effective {
	const rule = findRule(policy, capability, resource);

	if (rule !== undefined) {
		return rule.disposition;
	}

	return dangerous ? "review" : "allow";
}

/** Return a copy of `policy` with the (capability, resource) rule set to `disposition` (replacing any existing).
 *  `added` (an ISO stamp, passed by the caller that owns the clock) records first-authorization: it's set on a
 *  brand-new rule and PRESERVED from the existing rule across a later disposition flip, so it always means "when
 *  I first decided this", not "when I last touched it". */
export function withRule(policy: Policy, capability: string, resource: string, disposition: Disposition, added?: string): Policy {
	const existing = policy.rules.find((rule) => rule.capability === capability && rule.resource === resource);
	const rules = policy.rules.filter((rule) => !(rule.capability === capability && rule.resource === resource));
	const rule: Rule = { "capability": capability, "resource": resource, "disposition": disposition };
	const stamp = existing?.added ?? added;

	if (stamp !== undefined) {
		rule.added = stamp;
	}

	rules.push(rule);
	rules.sort((a, b) => (a.capability + a.resource).localeCompare(b.capability + b.resource));

	return { "version": policy.version, "rules": rules };
}

/** Return a copy of `policy` with any (capability, resource) rule removed (→ back to the computed default). */
export function withoutRule(policy: Policy, capability: string, resource: string): Policy {
	return { "version": policy.version, "rules": policy.rules.filter((rule) => !(rule.capability === capability && rule.resource === resource)) };
}

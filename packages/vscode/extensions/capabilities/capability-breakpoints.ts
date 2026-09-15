/**
 * Capability breakpoints — the DECOUPLED decision layer between the capability policy and a debugger. A debugger
 * that runs the program (tsval's stepping VM today; an almostnode "production" adapter later) calls this at its
 * host-call boundary — the same `beforeCall` seam the canary uses — to answer ONE question: does the policy
 * require a hard stop here? If so, the debugger pauses at that line (native VS Code debug UI); the user inspects,
 * steps (back, under tsval), and decides.
 *
 * Kept free of any debugger/vscode dependency (only `typescript` for the AST node shape + policy-core + silo's
 * danger set) so it can be consumed from either the tsval debug worker or an almostnode adapter without coupling
 * to either — the point of building it standalone first.
 *
 * Classification is AST-based (callee name → capability, a fixed argument as the resource), NOT the canary's
 * tagged-stand-in trick: a debugger runs the program's REAL (or almostnode-shimmed) capabilities, not the canary's
 * mocks, so there are no tags to read — the call node is what we have. (Aliasing like `const f = fetch` isn't
 * caught here, unlike the canary; a later refinement can resolve it.)
 */
import { isDangerous } from "@brianjenkins94/util/silo/policy";
import { effectiveDisposition, type Policy } from "./policy-core";
import ts from "typescript";

/** A capability call the debugger reached: what it is, and the resource it targets (when a string). */
export interface CapabilityHit {
	"capability": string;
	"resource": string;
	"callee": string;
	"dangerous": boolean;
}

interface Matcher {
	"capability": string;
	/** Which argument carries the resource (URL / path / command). */
	"arg": number;
}

/** Bare-identifier callees (`fetch(...)`) and the fido/http verb surface → net. */
const IDENTIFIER_MATCHERS: Record<string, Matcher> = {
	"fetch": { "capability": "net", "arg": 0 }
};

/** Method callees (`fs.writeFile(...)`, `child_process.spawn(...)`, or a destructured `writeFile(...)`), keyed by
 *  the method/function name — the node fs + child_process capability surface. */
const NAME_MATCHERS: Record<string, Matcher> = {
	"fetch": { "capability": "net", "arg": 0 },
	"readFile": { "capability": "fs:read", "arg": 0 },
	"readFileSync": { "capability": "fs:read", "arg": 0 },
	"writeFile": { "capability": "fs:write", "arg": 0 },
	"writeFileSync": { "capability": "fs:write", "arg": 0 },
	"appendFile": { "capability": "fs:write", "arg": 0 },
	"appendFileSync": { "capability": "fs:write", "arg": 0 },
	"unlink": { "capability": "fs:write", "arg": 0 },
	"unlinkSync": { "capability": "fs:write", "arg": 0 },
	"spawn": { "capability": "exec", "arg": 0 },
	"spawnSync": { "capability": "exec", "arg": 0 },
	"exec": { "capability": "exec", "arg": 0 },
	"execSync": { "capability": "exec", "arg": 0 },
	"execFile": { "capability": "exec", "arg": 0 }
};

/** Render a callee for display: `fetch` or `fs.writeFile` (`?` for a dynamic receiver). */
function renderCallee(callee: ts.Expression): string {
	if (ts.isIdentifier(callee)) {
		return callee.text;
	}

	if (ts.isPropertyAccessExpression(callee)) {
		return (ts.isIdentifier(callee.expression) ? callee.expression.text : "?") + "." + callee.name.text;
	}

	return "?";
}

/** Match a call's callee to a capability matcher (identifier or `.method`), or undefined. */
function matcherFor(callee: ts.Expression): Matcher | undefined {
	if (ts.isIdentifier(callee)) {
		return IDENTIFIER_MATCHERS[callee.text] ?? NAME_MATCHERS[callee.text];
	}

	if (ts.isPropertyAccessExpression(callee)) {
		return NAME_MATCHERS[callee.name.text];
	}
}

/** Classify a host call at runtime into a capability hit (with the evaluated resource), or undefined if it isn't a
 *  capability call. `args` are the arguments AS EVALUATED (what the debugger's beforeCall already has). */
export function classifyCall(node: ts.CallExpression, args: readonly unknown[]): CapabilityHit | undefined {
	const matcher = matcherFor(node.expression);

	if (matcher === undefined) {
		return undefined;
	}

	const resource = args[matcher.arg];

	return {
		"capability": matcher.capability,
		"resource": typeof resource === "string" ? resource : "",
		"callee": renderCallee(node.expression),
		"dangerous": isDangerous(matcher.capability)
	};
}

/**
 * Does the policy require a hard stop at this capability hit? Break on anything NOT explicitly allowed — an
 * explicit `deny`, or an undecided dangerous call (`review`) — so the debugger pauses for every capability the
 * user hasn't cleared, firewall-style. `allow` (and non-dangerous, undecided) passes straight through.
 */
export function shouldBreak(policy: Policy, hit: CapabilityHit): boolean {
	return effectiveDisposition(policy, hit.capability, hit.resource, hit.dangerous) !== "allow";
}

/** A static capability call site in a source file (no args yet → no resource): where a debugger could pre-mark or
 *  pre-arm a capability breakpoint before the run. */
export interface CapabilitySite {
	"capability": string;
	"callee": string;
	"start": number;
	"end": number;
}

/** Walk a SourceFile for every capability call SITE (by callee), for pre-arming breakpoints / gutter markers. */
export function findCapabilitySites(sourceFile: ts.SourceFile): CapabilitySite[] {
	const sites: CapabilitySite[] = [];

	(function visit(node: ts.Node): void {
		if (ts.isCallExpression(node)) {
			const matcher = matcherFor(node.expression);

			if (matcher !== undefined) {
				sites.push({ "capability": matcher.capability, "callee": renderCallee(node.expression), "start": node.getStart(sourceFile), "end": node.getEnd() });
			}
		}

		node.forEachChild(visit);
	})(sourceFile);

	return sites;
}

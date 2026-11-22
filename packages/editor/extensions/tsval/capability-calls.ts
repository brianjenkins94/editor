import type { Policy } from "@brianjenkins94/util/silo/policy";
import { FS_ASYNC, FS_DESTINATION, FS_SYNC } from "@brianjenkins94/almostnode/fs-capabilities";
import { effectiveDisposition, givenResult, isDangerous } from "@brianjenkins94/util/silo/policy";
import ts from "typescript";

export interface CapabilityHit {
	"capability": string;
	"resource": string;
	"callee": string;
	"dangerous": boolean;
	"argIndex": number;
}

interface Matcher {
	"capability": string;
	"arg": number;
}

const IDENTIFIER_MATCHERS: Record<string, Matcher[]> = {
	"fetch": [{ "capability": "net", "arg": 0 }]
};

const NAME_MATCHERS: Record<string, Matcher[]> = {
	...Object.fromEntries(Object.entries({ ...FS_SYNC, ...FS_ASYNC }).map(([method, op]) => [method, [{ "capability": "fs:" + op, "arg": 0 }, ...FS_DESTINATION[method] === undefined ? [] : [{ "capability": "fs:" + FS_DESTINATION[method], "arg": 1 }]]])),
	"spawn": [{ "capability": "exec", "arg": 0 }],
	"spawnSync": [{ "capability": "exec", "arg": 0 }],
	"exec": [{ "capability": "exec", "arg": 0 }],
	"execSync": [{ "capability": "exec", "arg": 0 }],
	"execFile": [{ "capability": "exec", "arg": 0 }]
};

export function renderCallee(callee: ts.Expression): string {
	if (ts.isIdentifier(callee)) {
		return callee.text;
	}

	if (ts.isPropertyAccessExpression(callee)) {
		return (ts.isIdentifier(callee.expression) ? callee.expression.text : "?") + "." + callee.name.text;
	}

	return "?";
}

function matchersFor(callee: ts.Expression): Matcher[] | undefined {
	const own = (table: Record<string, Matcher[]>, name: string): Matcher[] | undefined => (Object.hasOwn(table, name) ? table[name] : undefined);

	if (ts.isIdentifier(callee)) {
		return own(IDENTIFIER_MATCHERS, callee.text) ?? own(NAME_MATCHERS, callee.text);
	}

	if (ts.isPropertyAccessExpression(callee)) {
		return own(NAME_MATCHERS, callee.name.text);
	}
}

export function classifyCall(node: ts.CallExpression, args: readonly unknown[]): CapabilityHit[] {
	return (matchersFor(node.expression) ?? []).map((matcher) => {
		const resource = args[matcher.arg];

		return {
			"capability": matcher.capability,
			"resource": typeof resource === "string" ? resource : "",
			"callee": renderCallee(node.expression),
			"dangerous": isDangerous(matcher.capability),
			"argIndex": matcher.arg
		};
	});
}

export function shouldBreak(policy: Policy, hit: CapabilityHit): boolean {
	return effectiveDisposition(policy, hit.capability, hit.resource, hit.dangerous, { "trigger": "you" }) === "review" && givenResult(policy, { "trigger": "you", "capability": hit.capability, "resource": hit.resource }) === undefined;
}

export function capabilityBreakLines(sourceFile: ts.SourceFile, policy: Policy): number[] {
	const lines = new Set<number>();

	(function visit(node: ts.Node): void {
		if (ts.isCallExpression(node)) {
			for (const hit of classifyCall(node, [])) {
				const argNode = node.arguments[hit.argIndex];
				const resource = argNode !== undefined && ts.isStringLiteralLike(argNode) ? argNode.text : "";

				if (shouldBreak(policy, { ...hit, "resource": resource })) {
					lines.add(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
				}
			}
		}

		node.forEachChild(visit);
	})(sourceFile);

	return [...lines];
}

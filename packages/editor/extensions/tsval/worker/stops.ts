import type { CapabilityAsk, Control } from "../debug-protocol";
import type { Place, Vm } from "./state";
import ts from "typescript";
import { classifyCall, shouldBreak, capabilityBreakLines } from "../capability-calls";
import { lineReaches, probeResource } from "./gate";
import { arm, fileAt, rangeOf } from "./session";
import { state } from "./state";

export function askAt(vm: Vm, place: Place): CapabilityAsk | undefined {
	const file = fileAt(vm, place);
	const { line } = place;

	if (file === undefined || state.policy === undefined) {
		return undefined;
	}

	const calls: ts.CallExpression[] = [];

	(function visit(node: ts.Node): void {
		if (ts.isCallExpression(node) && file.getLineAndCharacterOfPosition(node.getStart(file)).line === line - 1) {
			calls.push(node);
		}

		node.forEachChild(visit);
	})(file);

	for (const call of calls) {
		const hits = classifyCall(call, []);

		if (hits.length === 0 || lineReaches(vm, place, call) === false) {
			continue;
		}

		for (const hit of hits) {
			const before = resourceOf(vm, call.arguments[hit.argIndex], file);
			const probe = before.resolved ? undefined : probeResource(vm, place, hit.capability, hit.argIndex);
			const { resource, resolved } = probe === undefined ? before : { "resource": probe, "resolved": true };

			if (shouldBreak(state.policy, { ...hit, "resource": resolved ? resource : "" })) {
				return { "line": line - 1, "at": rangeOf(call), "capability": hit.capability, "callee": hit.callee, "resource": resource, "resolved": resolved, "dangerous": hit.dangerous, ...file === state.sourceFile ? {} : { "file": file.fileName, "source": file.text } };
			}
		}
	}

	return undefined;
}

function resourceOf(vm: Vm, argument: ts.Expression | undefined, file: ts.SourceFile): { "resource": string; "resolved": boolean } {
	if (argument === undefined) {
		return { "resource": "", "resolved": false };
	}

	if (ts.isStringLiteralLike(argument)) {
		return { "resource": argument.text, "resolved": true };
	}

	if (ts.isIdentifier(argument)) {
		for (let scope: typeof vm.rootScope | undefined = vm.top?.scope ?? vm.rootScope; scope !== undefined; scope = scope.parent) {
			for (const [name, binding] of scope.bindings) {
				if (name === argument.text && binding.initialized && typeof binding.value === "string") {
					return { "resource": binding.value, "resolved": true };
				}
			}
		}
	}

	return { "resource": argument.getText(file), "resolved": false };
}

export function decide(message: Extract<Control, { "type": "decide" }>): void {
	if (message.policy !== undefined) {
		const now = message.policy;

		state.policy = now;
		state.capabilityLines = new Map([...state.programFiles].map(([name, file]) => [name, new Set(capabilityBreakLines(file, now))]));

		for (const vm of new Set([state.current, ...state.history])) {
			if (vm !== undefined) {
				arm(vm);
			}
		}
	}

	state.denyNext = message.deny === true;
	state.skipNext = message.skip === true;
	state.answeredNext = message.decided;
	state.giveNext = message.give === undefined ? undefined : { "value": message.give };
	state.allowNext = !state.denyNext && !state.skipNext && state.giveNext === undefined;
}

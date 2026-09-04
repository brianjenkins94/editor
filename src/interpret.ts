import { parse } from "./frontend.ts";
import { VM, type VMOptions } from "./vm.ts";
import { createTypedProgram } from "./program.ts";

export interface InterpretOptions extends VMOptions {
	fileName?: string;
}

/** Parse `code` and build a VM seated at its SourceFile, ready to `step()`/`run()`. */
export function createVM(code: string, options: InterpretOptions = {}): VM {
	const sourceFile = parse(code, options.fileName);
	const vm = new VM(options);
	vm.load(sourceFile);
	return vm;
}

/**
 * Like `createVM`, but type-aware: builds a `Program` + `TypeChecker` and seats the VM on the
 * Program's own SourceFile so node identities line up with checker queries (ASSIGNMENT S6). Heavier —
 * only for runs that need types.
 */
export function createTypedVM(code: string, options: InterpretOptions = {}): VM {
	const { sourceFile, checker } = createTypedProgram(code, options.fileName);
	const vm = new VM({ ...options, typeChecker: checker });
	vm.load(sourceFile);
	return vm;
}

/** Parse and run `code` to completion; returns the completion value (last ExpressionStatement). */
export function interpret(code: string, options: InterpretOptions = {}): unknown {
	return createVM(code, options).run();
}

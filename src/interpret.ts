import { parse } from "./frontend.ts";
import { VM, type VMOptions } from "./vm.ts";

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

/** Parse and run `code` to completion; returns the completion value (last ExpressionStatement). */
export function interpret(code: string, options: InterpretOptions = {}): unknown {
	return createVM(code, options).run();
}

/** Like `interpret`, but drives top-level `await` (a module's main body is itself a suspendable fiber). */
export function interpretAsync(code: string, options: InterpretOptions = {}): Promise<unknown> {
	return createVM(code, options).runAsync();
}

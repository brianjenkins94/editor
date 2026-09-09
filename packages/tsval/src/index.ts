export { isUncatchable, TsvalInternalError, UNCATCHABLE } from "./errors.ts";
export { parse, syntaxKindName, ts } from "./frontend.ts";
export { standardGlobals } from "./globals.ts";
export { createVM, interpret, interpretAsync } from "./interpret.ts";
export type { InterpretOptions, LoadedVM } from "./interpret.ts";
export type { Binding, Scope } from "./scope.ts";
export { isGuestFunction } from "./values.ts";
export type { GuestFunction, GuestFunctionMeta } from "./values.ts";
/**
 * The interpreter's public surface. The type-aware layer is separate and opt-in:
 * `@brianjenkins94/tsval/typed` (the interpreter itself knows no TypeChecker).
 */
export { VM } from "./vm.ts";
export type { Frame, HostCallSite, HostGuard, Signal, VMOptions } from "./vm.ts";

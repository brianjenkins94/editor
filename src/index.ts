/**
 * The interpreter's public surface. The type-aware layer is separate and opt-in:
 * `@brianjenkins94/tsval/typed` (the interpreter itself knows no TypeChecker).
 */
export { VM } from "./vm.ts";
export type { VMOptions, HostGuard, HostCallSite, Frame, Signal } from "./vm.ts";
export type { Scope, Binding } from "./scope.ts";
export { parse, syntaxKindName, ts } from "./frontend.ts";
export { createVM, interpret, interpretAsync } from "./interpret.ts";
export type { InterpretOptions } from "./interpret.ts";
export { isGuestFunction } from "./values.ts";
export type { GuestFunction, GuestFunctionMeta } from "./values.ts";
export { TsvalInternalError, isUncatchable, UNCATCHABLE } from "./errors.ts";
export { standardGlobals } from "./globals.ts";

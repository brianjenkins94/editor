export { VM } from "./vm.ts";
export type { Frame, NodeFrame, CallFrame, ConstructFrame, InitFieldsFrame, PatternFrame, SyntheticFrame, Signal, VMOptions, NodeHandler, SyntheticHandlers } from "./vm.ts";
export { Scope } from "./scope.ts";
export type { Binding, BindingKind } from "./scope.ts";
export { parse, syntaxKindName, ts } from "./frontend.ts";
export { createVM, interpret, interpretAsync } from "./interpret.ts";
export type { InterpretOptions } from "./interpret.ts";
// The interpreter knows no TypeChecker. Type-awareness is a separate, opt-in layer: `@brianjenkins94/tsval/typed`.
export { isGuestFunction } from "./values.ts";
export type { GuestFunction, GuestFunctionMeta } from "./values.ts";
export { nodeHandlers, syntheticHandlers, createGuestFunction } from "./handlers.ts";
export { TsvalInternalError, unimplemented, isUncatchable, UNCATCHABLE } from "./errors.ts";
export type { HostGuard, HostCallSite } from "./vm.ts";
export { standardGlobals } from "./globals.ts";

export { isUncatchable, TsvalInternalError, UNCATCHABLE } from "./errors.ts";
export type { Candidate, Choice, EventLoopOptions, Loop } from "./event-loop.ts";
export { explore, runToEnd } from "./explore.ts";
export type { ModuleLoader, ModuleRecord, ResolvedModule } from "./modules.ts";
export type { Explored, Run } from "./explore.ts";
export { parse, syntaxKindName, ts } from "./frontend.ts";
export { standardGlobals } from "./globals.ts";
export { createVM, interpret, interpretAsync } from "./interpret.ts";
export type { InterpretOptions, LoadedVM } from "./interpret.ts";
export type { Binding, Scope } from "./scope.ts";
export { isGuestFunction, typeTag } from "./values.ts";
export type { GuestFunction, GuestFunctionMeta } from "./values.ts";
/**
 * The interpreter's public surface. The type-aware layer is separate and opt-in:
 * `@brianjenkins94/tsval/typed` (the interpreter itself knows no TypeChecker).
 */
export { VM } from "./vm.ts";
export type { Frame, HostCallSite, HostGuard, Observer, ObserveSite, Signal, StatementProfile, TraceEvent, Tracer, VMOptions } from "./vm.ts";

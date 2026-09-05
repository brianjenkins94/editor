/**
 * The node and synthetic-frame handlers, split by concern under ./handlers/. Importing this module
 * registers every handler (each module registers into the registry at load) and re-exports the
 * surface the VM, the frames and the public API use.
 */
import "./handlers/realm.ts";
import "./handlers/hoist.ts";
import "./handlers/iteration.ts";
import "./handlers/references.ts";
import "./handlers/operators.ts";
import "./handlers/literals.ts";
import "./handlers/functions.ts";
import "./handlers/calls.ts";
import "./handlers/generators.ts";
import "./handlers/statements.ts";
import "./handlers/classes.ts";
import "./handlers/patterns.ts";

export { nodeHandlers, syntheticHandlers } from "./handlers/registry.ts";
export { createGuestFunction } from "./handlers/functions.ts";
export { createGuestClass, clonePrivateElements, isGuestClass, type GuestClass, type ClassMeta } from "./handlers/classes.ts";
export { bindIdentifier, bindingProgram, assignProgram, pushPattern, PatternProgram } from "./handlers/patterns.ts";
export { closeIteration, closeIterator, getIterator, type IterRecord } from "./handlers/iteration.ts";
export type { Ref } from "./handlers/references.ts";

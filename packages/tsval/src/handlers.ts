/**
 * The node and synthetic-frame handlers, split by concern under ./handlers/. Each module exports its
 * handlers as named functions plus a `register()` table; importing this module registers them all
 * and re-exports the surface the VM, the frames and the public API use.
 */
import { register as registerCalls } from "./handlers/calls.ts";
import { register as registerClasses } from "./handlers/classes.ts";
import { register as registerFunctions } from "./handlers/functions.ts";
import { register as registerGenerators } from "./handlers/generators.ts";
import { register as registerHoist } from "./handlers/hoist.ts";
import { register as registerIteration } from "./handlers/iteration.ts";
import { register as registerLiterals } from "./handlers/literals.ts";
import { register as registerOperators } from "./handlers/operators.ts";
import { register as registerPatterns } from "./handlers/patterns.ts";
import { register as registerRealm } from "./handlers/realm.ts";
import { register as registerReferences } from "./handlers/references.ts";
import { register as registerStatements } from "./handlers/statements.ts";

// Registration is a plain call AFTER every module has loaded — no module reads another at
// evaluation time, so their import order (and the cycles among them) cannot matter.
registerRealm();
registerHoist();
registerIteration();
registerReferences();
registerOperators();
registerLiterals();
registerFunctions();
registerCalls();
registerGenerators();
registerStatements();
registerClasses();
registerPatterns();

export { type ClassMeta, clonePrivateElements, type Construction, createGuestClass, type GuestClass, isGuestClass } from "./handlers/classes.ts";
export { createGuestFunction } from "./handlers/functions.ts";
export { closeIteration, closeIterator, getIterator, type IterRecord } from "./handlers/iteration.ts";
export { assignProgram, bindIdentifier, bindingProgram, PatternProgram, pushPattern } from "./handlers/patterns.ts";
export type { Ref } from "./handlers/references.ts";
export { nodeHandlers, syntheticHandlers } from "./handlers/registry.ts";

/** unenv's Buffer — the one a program's `require("buffer")` gives (builtins.ts) — for almostnode's own code, typed as
 *  Node's (unenv declares it `unknown`). */
import { Buffer as UnenvBuffer } from "unenv/node/buffer";

// (a value only: `Buffer` as a type is Node's global one)
export const Buffer = UnenvBuffer as typeof globalThis.Buffer;

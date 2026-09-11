import { clamp, sum } from "./math";
import { Counter } from "./counter";

// The bundled demo workspace the editor opens on. Edit these files in the workbench — type-checking,
// go-to-definition across the local files, and the explorer all work with no server. (Kept self-contained:
// an external package import makes tsserver reach across origins, which stalls under the cross-origin
// isolation Pages requires — see counter.ts.)

const total = sum([2, 3, 5, 8]);
const bounded = clamp(total, 0, 10);

const counter = new Counter(bounded);

counter.increment();

console.log(`total=${total} bounded=${bounded} count=${counter.value}`);

import { clamp, sum } from "./math";
import { Counter } from "./counter";

// The bundled demo workspace the editor opens on. Edit these files in the workbench — type-checking,
// go-to-definition (including into `preact` from the CDN, streamed same-origin via __proxy__), and the
// explorer all work with no server.

const total = sum([2, 3, 5, 8]);
const bounded = clamp(total, 0, 10);

const counter = new Counter(bounded);

counter.increment();

console.log(`total=${total} bounded=${bounded} count=${counter.value}`);

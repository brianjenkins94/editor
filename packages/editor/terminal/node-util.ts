/**
 * `node:util` in the workbench's browser build — what juvy asks of it: `parseArgs` for `.parse()`, from @pkgjs/parseargs
 * (Node's own parseArgs, as a package; a browser has none), and `inspect` for cmd-ts, which draws juvy's `--help`, from
 * the browser util polyfill. juvy runs the terminal's commands (invoke.ts), so the workbench build resolves `node:util`
 * here (build.ts).
 */
export { parseArgs } from "@pkgjs/parseargs";
export { inspect } from "util";

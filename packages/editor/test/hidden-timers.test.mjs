// A hidden tab's timers (shared/hidden-timers.ts): which are the worker's, and that they fire, repeat and clear as the
// realm's own do — over a stand-in worker keeping time with Node's timers.
import assert from "node:assert/strict";
import { test } from "node:test";

import { installHiddenTabTimers } from "../shared/hidden-timers.ts";

/** A realm: its own timers counted, a tab that's hidden or not, and a worker running the clock's script as a worker would. */
function realm({ hidden }) {
	const own = [];
	const scope = {
		"document": { "hidden": hidden },
		"setTimeout": (callback, ms, ...args) => { own.push(["timeout", ms]); return setTimeout(callback, ms, ...args); },
		"setInterval": (callback, ms, ...args) => { own.push(["interval", ms]); return setInterval(callback, ms, ...args); },
		"clearTimeout": (id) => { clearTimeout(id); },
		"clearInterval": (id) => { clearInterval(id); },
		"Worker": class {
			#listeners = [];
			// (its own onmessage, so the script's assignment lands here, not on Node's global)
			#inside = { "onmessage": undefined };

			constructor(url) {
				// (the clock's own script, run with this stand-in's postMessage)
				const source = globalThis.__clockSource;

				// eslint-disable-next-line no-new-func -- running the clock's script as its worker would is this stand-in's point
				new Function("self", `with (self) { ${source} }`)(Object.assign(this.#inside, { "postMessage": (data) => { setTimeout(() => { for (const listener of this.#listeners) listener({ data }); }); }, setTimeout, setInterval, clearTimeout, clearInterval }));
				URL.revokeObjectURL(url);
			}

			addEventListener(_type, listener) {
				this.#listeners.push(listener);
			}

			postMessage(data) {
				setTimeout(() => { this.#inside.onmessage({ data }); });
			}
		}
	};

	return { own, scope };
}

// (the clock's script, as the module makes it: read from the Blob it hands the Worker)
const RealBlob = globalThis.Blob;

globalThis.Blob = class extends RealBlob {
	constructor(parts, options) {
		super(parts, options);
		globalThis.__clockSource = parts.join("");
	}
};

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

test("while the tab is hidden, a timer is the worker's: it fires, with its arguments and the realm as `this`", async () => {
	const { own, scope } = realm({ "hidden": true });

	installHiddenTabTimers(scope);

	const fired = [];
	const id = scope.setTimeout(function (a, b) { fired.push([a, b, this === scope]); }, 20, "a", "b");

	assert.ok(id >= 1_000_000_000, "an id apart from the realm's own");
	await wait(80);
	assert.deepEqual(fired, [["a", "b", true]]);
	assert.deepEqual(own, [], "none of the realm's own");
});

test("an interval repeats until cleared, and either clear clears either, as the browser's do", async () => {
	const { scope } = realm({ "hidden": true });

	installHiddenTabTimers(scope);

	let ticks = 0;
	const interval = scope.setInterval(() => { ticks += 1; }, 10);

	await wait(75);
	scope.clearTimeout(interval);

	const seen = ticks;

	await wait(50);
	assert.ok(seen >= 3, `it repeated (${String(seen)})`);
	assert.equal(ticks, seen, "and stopped when cleared");

	let fired = false;

	scope.clearInterval(scope.setTimeout(() => { fired = true; }, 10));
	await wait(50);
	assert.equal(fired, false);
});

test("while the tab is shown, a short timer is the realm's own; one of a second or more is the worker's", async () => {
	const { own, scope } = realm({ "hidden": false });

	installHiddenTabTimers(scope);

	let short = false;
	const id = scope.setTimeout(() => { short = true; }, 5);
	const long = scope.setTimeout(() => {}, 1000);

	assert.ok(id < 1_000_000_000 && long >= 1_000_000_000);
	assert.deepEqual(own, [["timeout", 5]]);
	scope.clearTimeout(long);
	await wait(30);
	assert.equal(short, true);
});

test("once a realm, and not at all where there's no worker", () => {
	const { scope } = realm({ "hidden": true });

	installHiddenTabTimers(scope);

	const once = scope.setTimeout;

	installHiddenTabTimers(scope);
	assert.equal(scope.setTimeout, once);

	const bare = { ...realm({ "hidden": true }).scope, "Worker": undefined };
	const theirs = bare.setTimeout;

	installHiddenTabTimers(bare);
	assert.equal(bare.setTimeout, theirs);
});

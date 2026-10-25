/**
 * almostnode's Node built-ins: Node's own code wherever it's on npm, unenv's where it's a port of Node's or Node's can't
 * run here, almostnode's own where it has to differ — and what can't be done here says so ("not implemented") rather than
 * pretending. Audited 2026-10-24, module by module (each miss so far was a module unenv wrote itself where Node's code
 * exists; test/builtins.test.ts holds each behaviour that differed):
 *
 *   - Node's own code, from npm: assert (`assert`), stream and stream/promises (`readable-stream`: Node's lib/stream.js
 *     and its internals), string_decoder, events' EventEmitter (`events`: unenv's is a class, which code written for Node
 *     can't `EventEmitter.call(this)`), util's inspect, format, formatWithOptions, stripVTControlCharacters
 *     (`node-inspect-extracted`: Node's lib/internal/util/inspect.js — unenv's inspect was JSON) and isDeepStrictEqual
 *     (assert's comparisons), path and path/posix (`path-browserify`: Node's lib/path.js — pathe took a backslash for a
 *     separator — resolving against the program's directory, its format as Node's is now).
 *   - unenv's ports of Node's code: querystring and url (Node 22.7's lib), punycode (the package Node bundles), buffer
 *     (feross/buffer, the browser's Buffer: Node's own is native), constants (Node's values).
 *   - unenv's own, where Node's can't run here and nothing on npm is Node's: os (a made-up Linux machine: there's no real
 *     one to describe), tty (not a terminal: `isatty` false), worker_threads (its Worker constructs and never runs —
 *     tools make one as they load and never use it here: eslint-plugin-jsonc, through synckit; one that threw broke them), diagnostics_channel (`hasSubscribers` a boolean, as Node's),
 *     path.win32 (pathe's, posix-like: a program here runs on posix), trace_events, inspector, cluster, perf_hooks, domain,
 *     dns (with almostnode's lookup over them: Vite resolving `localhost`).
 *   - almostnode's own (`oursOver`, unenv filling in what it lacks): what the editor is behind (http, https, http2, net,
 *     tls — the dev servers' bridge; child_process's ENOSYS), what almostnode implements and unenv stubs (crypto's hashes,
 *     zlib, vm, module, async_hooks), the runtime's console; and where Node's is native and unenv's answered wrongly —
 *     util/types (brand checks: unenv's boxed-primitive checks were Node's opposite), timers and timers/promises (the
 *     realm's timers when called; unenv's bound them before the runtime made them Node's, and its promises didn't wait),
 *     readline and readline/promises (the input's lines; unenv's answered every question with "").
 *   - Stubs that say "not implemented" (unenv's, or almostnode's `notImplemented` where unenv's mock pretended, as it's
 *     used — never as a module loads): dgram's sockets, v8's serialization, repl's start, util.types.isProxy, and the names
 *     unenv's modules above don't have.
 *
 * `fs` and `process` aren't here: each runtime has its own (the runtime's require answers them).
 *
 * unenv's modules import each other by Node's names (`node:events`), and Node's code on npm imports `buffer`, `events`
 * and `process/`: unenv-resolve.ts makes those unenv's own, in a bundle and in almostnode's tests alike. almostnode's own
 * code builds on the modules here, as a program does: one EventEmitter, one Buffer.
 */
import * as unenvAsyncHooks from "unenv/node/async_hooks";
import * as unenvBuffer from "unenv/node/buffer";
import * as unenvChildProcess from "unenv/node/child_process";
import * as unenvCluster from "unenv/node/cluster";
import * as unenvConsole from "unenv/node/console";
import * as unenvConstants from "unenv/node/constants";
import * as unenvCrypto from "unenv/node/crypto";
import * as unenvDgram from "unenv/node/dgram";
import * as unenvDiagnosticsChannel from "unenv/node/diagnostics_channel";
import * as unenvDns from "unenv/node/dns";
import * as unenvDnsPromises from "unenv/node/dns/promises";
import * as unenvDomain from "unenv/node/domain";
import * as unenvEvents from "unenv/node/events";
import * as unenvHttp from "unenv/node/http";
import * as unenvHttp2 from "unenv/node/http2";
import * as unenvHttps from "unenv/node/https";
import * as unenvInspector from "unenv/node/inspector";
import * as unenvInspectorPromises from "unenv/node/inspector/promises";
import * as unenvModule from "unenv/node/module";
import * as unenvNet from "unenv/node/net";
import * as unenvOs from "unenv/node/os";
import * as unenvPath from "unenv/node/path";
import * as unenvPerfHooks from "unenv/node/perf_hooks";
import * as unenvPunycode from "unenv/node/punycode";
import * as unenvQuerystring from "unenv/node/querystring";
import * as unenvReadline from "unenv/node/readline";
import * as unenvReadlinePromises from "unenv/node/readline/promises";
import * as unenvRepl from "unenv/node/repl";
import * as unenvTimers from "unenv/node/timers";
import * as unenvTimersPromises from "unenv/node/timers/promises";
import * as unenvTls from "unenv/node/tls";
import * as unenvTraceEvents from "unenv/node/trace_events";
import * as unenvTty from "unenv/node/tty";
import * as unenvUrl from "unenv/node/url";
import * as unenvUtil from "unenv/node/util";
import * as unenvUtilTypes from "unenv/node/util/types";
import * as unenvV8 from "unenv/node/v8";
import * as unenvVm from "unenv/node/vm";
import * as unenvWorkerThreads from "unenv/node/worker_threads";
import * as unenvZlib from "unenv/node/zlib";
import * as asyncHooksShim from "./shims/async_hooks";
import * as childProcessShim from "./shims/child_process";
import * as cryptoShim from "./shims/crypto";
import * as dnsShim from "./shims/dns";
import * as domainShim from "./shims/domain";
import * as httpShim from "./shims/http";
import * as http2Shim from "./shims/http2";
import * as httpsShim from "./shims/https";
import * as moduleShim from "./shims/module";
import * as netShim from "./shims/net";
import * as perfHooksShim from "./shims/perf_hooks";
import * as readlineShim from "./shims/readline";
import * as timersShim from "./shims/timers";
import * as tlsShim from "./shims/tls";
import * as utilShim from "./shims/util";
import * as utilTypesShim from "./shims/util-types";
import * as vmShim from "./shims/vm";
import * as zlibShim from "./shims/zlib";
import nodeAssert from "assert/build/assert.js";
import comparisons from "assert/build/internal/util/comparisons.js";
import events from "events/events.js";
import { format, formatWithOptions, inspect, stripVTControlCharacters } from "node-inspect-extracted";
import nodePath from "path-browserify";
import stream from "readable-stream/lib/stream.js";
import stringDecoder from "string_decoder/lib/string_decoder.js";

type Namespace = Record<string, unknown>;

/** An ES module's namespace as `require()` returns it: its default export (unenv's is Node's CommonJS value), with any
 *  named export it doesn't carry. */
function required(namespace: Namespace): Record<string, unknown> {
	const value = namespace["default"];
	const named = Object.fromEntries(Object.entries(namespace).filter(([name]) => name !== "default"));

	// (a function — events' EventEmitter, assert — is the module, its named exports its properties)
	if (typeof value === "function") {
		for (const [name, each] of Object.entries(named)) {
			if (!(name in value)) {
				Object.defineProperty(value, name, { "value": each, "writable": true, "configurable": true, "enumerable": true });
			}
		}

		return value as unknown as Record<string, unknown>;
	}

	return value !== null && typeof value === "object" ? { ...named, ...value as Namespace } : named;
}

/** A function, or a class, that says it isn't implemented: what almostnode can't do, said rather than pretended (unenv's
 *  mocks of these did nothing, or answered wrongly). */
function notImplemented(name: string): (...args: unknown[]) => never {
	return function notHere(): never {
		throw new Error(`[almostnode] ${name} is not implemented`);
	};
}

/** unenv's module, as it is. */
const unenv = required;

/** unenv's module with `names` of almostnode's `ours` over it: where a program here needs them to work. */
function unenvWith(namespace: Namespace, ours: Namespace, names: string[]): Record<string, unknown> {
	return { ...required(namespace), ...Object.fromEntries(names.map((name) => [name, ours[name]])) };
}

/** almostnode's module, with what unenv's has that it lacks. A function (assert, EventEmitter) is ours, given unenv's
 *  missing names as its own properties; an object, a new one — ours over unenv's. */
function oursOver<T>(ours: T, namespace: Namespace): T {
	// (its named exports as well as its default's own names: a class's statics — events' `on` — aren't enumerable)
	const theirs = { ...required(namespace), ...Object.fromEntries(Object.entries(namespace).filter(([name]) => name !== "default")) };

	if (typeof ours === "function") {
		for (const [name, value] of Object.entries(theirs)) {
			if (!(name in ours)) {
				Object.defineProperty(ours, name, { "value": value, "writable": true, "configurable": true, "enumerable": true });
			}
		}

		return ours;
	}

	return { ...theirs, ...ours as Namespace } as T;
}

/**
 * What `namespace` (unenv's module) has that `target` (one of almostnode's own a runtime makes: its fs, its process)
 * lacks, put on it — read off unenv's default export; `bind`, its functions bound to that (unenv's process is an
 * instance whose methods use `this`).
 */
export function fillIn(target: object, namespace: Namespace, bind = false): void {
	const value = namespace["default"] as Namespace | undefined;

	for (const name of Object.keys(namespace).filter((key) => key !== "default")) {
		if (!(name in target)) {
			const own = value !== undefined && name in value ? value[name] : namespace[name];

			Object.defineProperty(target, name, { "value": bind && typeof own === "function" && value !== undefined ? (own as (...args: unknown[]) => unknown).bind(value) : own, "writable": true, "configurable": true, "enumerable": true });
		}
	}
}

/** The working directory of the program running: the runtime's process, which is the realm's while it runs. */
function cwd(): string {
	return (globalThis as { "process"?: { "cwd"?: () => string } }).process?.cwd?.() ?? "/";
}

/** The built-ins, by name (`node:` stripped), but `fs` and `process` (each runtime's own). `own`: almostnode's modules
 *  the runtime makes (its console), unenv filling in what they lack. */
export function nodeBuiltins(own: { "console": Namespace }): Record<string, unknown> {
	// util: Node's inspect and format (node-inspect-extracted: Node's lib/internal/util/inspect.js) and Node's deep
	// equality (assert's, as `assert` itself), over unenv's — whose inspect was JSON, whose format knew %s and %j, and
	// whose isDeepStrictEqual took two different Maps as equal.
	const types = oursOver(utilTypesShim as unknown as Namespace, unenvUtilTypes);
	const util = { ...unenvWith(unenvUtil, utilShim as unknown as Namespace, ["callbackify"]), "inspect": inspect, "format": format, "formatWithOptions": formatWithOptions, "stripVTControlCharacters": stripVTControlCharacters, "isDeepStrictEqual": comparisons.isDeepStrictEqual, "types": types };
	// path: Node's posix path (path-browserify: Node's lib/path.js), resolving against the program's directory, over
	// unenv's (pathe, which took a backslash for a separator) for what it lacks — win32 among it: pathe's, posix-like
	// (a program here runs on posix).
	// (and its format as Node's is now: a bare extension gets its dot — path-browserify's is Node 10's)
	// (Node's newer names — toNamespacedPath, matchesGlob — unenv's)
	const pathe = unenv(unenvPath);
	const posix: Record<string, unknown> = { ...pathe, ...nodePath, "resolve": (...segments: string[]) => nodePath.resolve(cwd(), ...segments), "format": (parts: Parameters<typeof nodePath.format>[0]) => nodePath.format({ ...parts, ...parts.ext !== undefined && parts.ext !== "" && !parts.ext.startsWith(".") ? { "ext": `.${parts.ext}` } : {} }) };

	posix["posix"] = posix;
	posix["win32"] = pathe["win32"];

	const path = posix;
	const timers = oursOver({ ...timersShim, "promises": timersShim.promises } as unknown as Namespace, unenvTimers);

	return {
		// unenv's, as they are
		"path": path,
		"path/posix": posix,
		"path/win32": path["win32"],
		"os": unenv(unenvOs),
		"querystring": unenv(unenvQuerystring),
		"url": unenv(unenvUrl),
		"punycode": unenv(unenvPunycode),
		"constants": unenv(unenvConstants),
		"timers": timers,
		"timers/promises": oursOver(timersShim.promises as unknown as Namespace, unenvTimersPromises),
		"tty": unenv(unenvTty),
		"readline": oursOver({ ...readlineShim } as unknown as Namespace, unenvReadline),
		"readline/promises": oursOver(readlineShim.promises as unknown as Namespace, unenvReadlinePromises),
		// (what unenv's mocks pretended — a serialized value an empty buffer, a socket that sent nothing — said instead)
		"v8": unenvWith(unenvV8, Object.fromEntries(["serialize", "deserialize", "Serializer", "Deserializer", "DefaultSerializer", "DefaultDeserializer"].map((name) => [name, notImplemented(`v8.${name}`)])), ["serialize", "deserialize", "Serializer", "Deserializer", "DefaultSerializer", "DefaultDeserializer"]),
		"dgram": unenvWith(unenvDgram, { "createSocket": notImplemented("dgram.createSocket"), "Socket": notImplemented("dgram.Socket") }, ["createSocket", "Socket"]),
		"cluster": unenv(unenvCluster),
		// (unenv's own — there's no port of Node's on npm — its hasSubscribers a boolean for a channel nobody made, as Node's)
		"diagnostics_channel": unenvWith(unenvDiagnosticsChannel, { "hasSubscribers": (name: string | symbol) => unenvDiagnosticsChannel.hasSubscribers(name) === true }, ["hasSubscribers"]),
		"inspector": unenv(unenvInspector),
		"inspector/promises": unenv(unenvInspectorPromises),
		"trace_events": unenv(unenvTraceEvents),
		"repl": unenv(unenvRepl),
		// (its Worker unenv's mock, which constructs and never runs: a Worker that threw as it's made broke tools that make
		// one as they load and never use it here — eslint-plugin-jsonc, through synckit)
		"worker_threads": unenv(unenvWorkerThreads),
		"util/types": types,
		// unenv's, with a program's needs over it
		"dns": unenvWith(unenvDns, dnsShim as unknown as Namespace, ["lookup", "resolve", "resolve4", "resolve6", "reverse", "promises"]),
		"dns/promises": unenvWith(unenvDnsPromises, dnsShim.promises as unknown as Namespace, ["lookup", "resolve", "resolve4", "resolve6", "reverse"]),
		"perf_hooks": unenvWith(unenvPerfHooks, perfHooksShim as unknown as Namespace, ["PerformanceObserver"]),
		"domain": unenvWith(unenvDomain, domainShim as unknown as Namespace, ["Domain", "create"]),
		// almostnode's, unenv filling in
		"http": oursOver(httpShim as unknown as Namespace, unenvHttp),
		"https": oursOver(httpsShim as unknown as Namespace, unenvHttps),
		"http2": oursOver(http2Shim as unknown as Namespace, unenvHttp2),
		"net": oursOver(netShim as unknown as Namespace, unenvNet),
		"tls": oursOver(tlsShim as unknown as Namespace, unenvTls),
		"child_process": oursOver(childProcessShim as unknown as Namespace, unenvChildProcess),
		"crypto": oursOver(cryptoShim as unknown as Namespace, unenvCrypto),
		"zlib": oursOver(zlibShim as unknown as Namespace, unenvZlib),
		"vm": oursOver(vmShim as unknown as Namespace, unenvVm),
		"module": oursOver(moduleShim as unknown as Namespace, unenvModule),
		"events": oursOver(events, unenvEvents),
		"buffer": unenv(unenvBuffer),
		"util": util,
		"sys": util,
		"async_hooks": oursOver(asyncHooksShim as unknown as Namespace, unenvAsyncHooks),
		"console": oursOver(own.console, unenvConsole),
		// Node's own code, from npm
		"assert": nodeAssert,
		"assert/strict": (nodeAssert as unknown as { "strict": unknown }).strict,
		"stream": stream,
		"stream/promises": stream.promises,
		"string_decoder": stringDecoder
	};
}

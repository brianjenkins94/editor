/**
 * almostnode's Node built-ins: unenv's (the Node modules esm.sh and Cloudflare's runtime build on — some ported from
 * Node's own source), and almostnode's own only where it has to differ. Three ways:
 *
 *   - unenv's module, as it is (`unenv`): what has nothing of the editor in it;
 *   - unenv's module, with a few of almostnode's names over it (`unenvWith`): what a program running here needs to work
 *     where unenv only says "not implemented" — Vite resolving `localhost` (dns.lookup), util's callbackify, say;
 *   - almostnode's module, unenv filling in what it lacks (`oursOver`): what the editor is behind (the dev servers'
 *     http/net bridge, child_process's ENOSYS), or what almostnode implements and unenv stubs (crypto's hashes, zlib,
 *     streams, vm). almostnode's own code builds on unenv's events and buffer, as a program does.
 *
 * `fs` and `process` aren't here: each runtime has its own (the runtime's require answers them).
 *
 * unenv's modules import each other by Node's names (`node:events`): unenv-resolve.ts makes those unenv's own, in a
 * bundle and in almostnode's tests alike.
 */
import * as unenvAssert from "unenv/node/assert";
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
import * as unenvStream from "unenv/node/stream";
import * as unenvStreamPromises from "unenv/node/stream/promises";
import * as unenvStringDecoder from "unenv/node/string_decoder";
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
import streamShim from "./shims/stream";
import * as tlsShim from "./shims/tls";
import * as utilShim from "./shims/util";
import * as vmShim from "./shims/vm";
import * as zlibShim from "./shims/zlib";

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

/** unenv's module, as it is. */
const unenv = required;

/** unenv's module with `names` of almostnode's `ours` over it: where a program here needs them to work. */
function unenvWith(namespace: Namespace, ours: Namespace, names: string[]): Record<string, unknown> {
	return { ...required(namespace), ...Object.fromEntries(names.map((name) => [name, ours[name]])) };
}

/** almostnode's module, with what unenv's has that it lacks. A function (assert, EventEmitter) is ours, given unenv's
 *  missing names as its own properties; an object, a new one — ours over unenv's. */
function oursOver<T>(ours: T, namespace: Namespace): T {
	const theirs = required(namespace);

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

/** The built-ins, by name (`node:` stripped), but `fs` and `process` (each runtime's own). `own`: almostnode's modules
 *  the runtime makes (its string_decoder and console), unenv filling in what they lack. */
export function nodeBuiltins(own: { "string_decoder": Namespace; "console": Namespace }): Record<string, unknown> {
	const util = unenvWith(unenvUtil, utilShim as unknown as Namespace, ["callbackify", "stripVTControlCharacters"]);
	const path = unenv(unenvPath);
	const assert = unenv(unenvAssert);
	const stream = oursOver(streamShim, unenvStream);

	return {
		// unenv's, as they are
		"path": path,
		"path/posix": path["posix"] ?? path,
		"path/win32": path["win32"],
		"os": unenv(unenvOs),
		"querystring": unenv(unenvQuerystring),
		"url": unenv(unenvUrl),
		"punycode": unenv(unenvPunycode),
		"constants": unenv(unenvConstants),
		"timers": unenv(unenvTimers),
		"timers/promises": unenv(unenvTimersPromises),
		"tty": unenv(unenvTty),
		"readline": unenv(unenvReadline),
		"readline/promises": unenv(unenvReadlinePromises),
		"v8": unenv(unenvV8),
		"dgram": unenv(unenvDgram),
		"cluster": unenv(unenvCluster),
		"diagnostics_channel": unenv(unenvDiagnosticsChannel),
		"inspector": unenv(unenvInspector),
		"inspector/promises": unenv(unenvInspectorPromises),
		"trace_events": unenv(unenvTraceEvents),
		"repl": unenv(unenvRepl),
		"worker_threads": unenv(unenvWorkerThreads),
		"util/types": unenv(unenvUtilTypes),
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
		"events": unenv(unenvEvents),
		"buffer": unenv(unenvBuffer),
		"util": util,
		"sys": util,
		"assert": assert,
		"assert/strict": (assert as unknown as { "strict": unknown }).strict,
		"async_hooks": oursOver(asyncHooksShim as unknown as Namespace, unenvAsyncHooks),
		"stream": stream,
		"stream/promises": oursOver((stream as unknown as { "promises": Namespace }).promises, unenvStreamPromises),
		"string_decoder": oursOver(own.string_decoder, unenvStringDecoder),
		"console": oursOver(own.console, unenvConsole)
	};
}

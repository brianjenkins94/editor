/**
 * The redaction gate (src/log.ts): whatever a record or a span is given, only the fields on its list reach a log line or a
 * trace. The Worker's other tests look for particular secrets in the logs, which its code doesn't log; this hands the gate
 * what nothing should, in a Node of its own (its log goes straight to its output), with Cloudflare's tracing stood in for.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const SECRETS = { "token": "ghu_secret", "code": "654321", "email": "someone@example.com", "ip": "203.0.113.9", "authorization": "DPoP secret", "query": "?code=1" };

/** Logs through the gate, each way there is; what reached the traces goes to stdout (its log, to stderr). */
const SAYING = `
import { registerHooks } from "node:module";

const traced = [];
const spanOf = (name) => {
	const span = { name, "attributes": {} };

	traced.push(span);

	return { "setAttributes": (attributes) => { Object.assign(span.attributes, attributes); }, "recordException": () => undefined, "end": () => undefined };
};

globalThis.__tracing = { "startSpan": spanOf, "startActiveSpan": (name, run) => run(spanOf(name)) };
registerHooks({ "resolve": (specifier, context, next) => (specifier === "cloudflare:workers" ? { "url": "data:text/javascript,export const tracing = globalThis.__tracing;", "shortCircuit": true } : next(specifier, context)) });

const { log } = await import(${JSON.stringify(new URL("../src/log.ts", import.meta.url).href)});
const secrets = ${JSON.stringify(SECRETS)};

log.info("refused", { "reason": "no such code", "path": "/token", ...secrets });

const span = log.span("request", { "method": "POST", ...secrets });

span.info("within", { "status": 400, ...secrets });
span.span("inside", secrets).end(secrets);
span.end({ "status": 400, ...secrets });
process.stdout.write(JSON.stringify(traced));
`;

test("only the listed fields reach a log line or a trace, whichever way they're passed", () => {
	const ran = spawnSync(process.execPath, ["--input-type=module", "--eval", SAYING], { "encoding": "utf8" });

	assert.equal(ran.status, 0, ran.stderr);
	assert.match(ran.stderr, /no such code/u);
	assert.match(ran.stderr, /\/token/u);
	assert.match(ran.stdout, /POST/u, "the span reached the trace, with what's listed");

	for (const [name, secret] of Object.entries(SECRETS)) {
		assert.ok(!ran.stderr.includes(secret), `${name} was logged`);
		assert.ok(!ran.stdout.includes(secret), `${name} reached the trace`);
	}
});

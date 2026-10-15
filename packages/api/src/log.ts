import type { TracerSpan } from "@brianjenkins94/util/logger";
import { log, setTracer, sinks } from "@brianjenkins94/util/logger";
import { tracing } from "cloudflare:workers";

/**
 * The Worker's logging: util's spans, written to Workers Logs and mirrored into Cloudflare's traces. Both outputs pass
 * one gate: a record's attributes and bound context, and every attribute set on a span's counterpart in the trace,
 * keep only the fields in FIELDS. Anything else is dropped, not masked. That's the README's redaction rule in code.
 * Tokens, codes, verifiers, DPoP proofs, headers, query strings, emails and IPs have no field here, so they can't
 * reach a log line or a trace by accident, whichever span method they're passed to. Adding a field is a reviewed
 * change to this list. (`reason` is only ever one of the fixed strings util/auth/dpop and src/tokens.ts give a refusal.)
 */
const FIELDS = new Set(["method", "path", "status", "error", "reason", "logger.trace_id", "logger.span_id", "logger.parent_span_id"]);

function allowed<T>(values: Record<string, T>): Record<string, T> {
	return Object.fromEntries(Object.entries(values).filter(([key]) => FIELDS.has(key)));
}

const outputs = sinks.splice(0, sinks.length);

sinks.push((record) => {
	const gated = { ...record, "attrs": allowed(record.attrs), "context": record.context && allowed(record.context) };

	for (const output of outputs) {
		output(gated);
	}
});

function gate(span: TracerSpan): TracerSpan {
	return {
		"setAttributes": (attributes) => span.setAttributes(allowed(attributes)),
		"recordException": (exception) => span.recordException(exception),
		"end": () => span.end()
	};
}

setTracer({
	"startSpan": (name) => gate(tracing.startSpan(name)),
	"startActiveSpan": (name, run) => tracing.startActiveSpan(name, (span) => run(gate(span)))
});

export { log };

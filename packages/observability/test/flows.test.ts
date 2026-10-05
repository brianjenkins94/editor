/**
 * Flows from sampled messages (src/flows.ts): a message is one id across its hops, what it caused hangs under it, and a
 * message whose cause was lost is linked, inferred, to the last one its sender received just before it.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { flowsOf } from "../src/flows.ts";

const call = { "t": 0, "from": "pod", "to": "workbench", "label": "annotations.resolve()", "id": "p.1" };

test("a message's hops are one message; what it caused hangs under it", () => {
	const [flow] = flowsOf([
		call,
		{ "t": 1, "from": "workbench", "to": "bablr", "label": "bablr.resolve()", "id": "w.1", "cause": "p.1" },
		{ "t": 5, "from": "bablr", "to": "workbench", "label": "↩ bablr.resolve()", "id": "b.1", "cause": "w.1" },
		// a preview's report, through the shell: one message, two hops
		{ "t": 10, "from": "preview:5173", "to": "shell", "label": "evidence.preview", "id": "t.1" },
		{ "t": 11, "from": "shell", "to": "workbench", "label": "evidence.preview", "id": "t.1" }
	]);

	assert.equal(flow!.label, "annotations.resolve()");
	assert.deepEqual(flow!.caused.map((message) => message.label), ["bablr.resolve()"]);
	assert.deepEqual(flow!.caused[0]!.caused.map((message) => message.label), ["↩ bablr.resolve()"]);
});

test("one message across hops keeps its whole path", () => {
	const flows = flowsOf([
		{ "t": 10, "from": "preview:5173", "to": "shell", "label": "evidence.preview", "id": "t.1" },
		{ "t": 11, "from": "shell", "to": "workbench", "label": "evidence.preview", "id": "t.1" }
	]);

	assert.deepEqual(flows.map((flow) => flow.path), [["preview:5173", "shell", "workbench"]]);
});

test("a lost cause is inferred from what the sender last received, shortly before; and only then", () => {
	const flows = flowsOf([
		call,
		// sent by the workbench after an await: no cause, 20ms after the call reached it
		{ "t": 20, "from": "workbench", "to": "bablr", "label": "bablr.resolve()", "id": "w.2" },
		// and one much later: nothing to link it to
		{ "t": 500, "from": "workbench", "to": "bablr", "label": "bablr.spans()", "id": "w.3" }
	]);

	assert.deepEqual(flows.map((flow) => flow.label), ["annotations.resolve()", "bablr.spans()"]);
	assert.deepEqual(flows[0]!.caused.map((message) => [message.label, message.inferred]), [["bablr.resolve()", true]]);
});

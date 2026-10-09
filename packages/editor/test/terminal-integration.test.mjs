// The OSC 633 sequences our terminal prints for VS Code's shell integration (terminal-integration.ts).
import * as assert from "node:assert/strict";
import { test } from "node:test";

import { commandFinished, commandLine, workingDirectory } from "../terminal-integration.ts";

// VS Code's own reading of a sequence's value (shellIntegrationAddon.ts, deserializeVSCodeOscMessage).
const deserialize = (message) => message.replaceAll(/\\(\\|x([0-9a-f]{2}))/giu, (_match, op, hex) => (hex ? String.fromCharCode(Number.parseInt(hex, 16)) : op));
const value = (sequence, prefix) => {
	assert.ok(sequence.startsWith("\x1b]633;" + prefix) && sequence.endsWith("\x07"), JSON.stringify(sequence));

	return sequence.slice(("\x1b]633;" + prefix).length, -1);
};

test("a command line comes through VS Code's reading as it was typed — separators, backslashes, spaces and all", () => {
	const typed = "echo \"a;b\" | sed 's/\\\\/x/' && cd 'my dir'\t# done";
	const escaped = value(commandLine(typed), "E;");

	assert.ok(!escaped.includes(";") && !/[\x00-\x20]/u.test(escaped), "nothing that would end or split the sequence");
	assert.equal(deserialize(escaped), typed);
});

test("the working directory too, and a finish with or without its exit code", () => {
	assert.equal(deserialize(value(workingDirectory("/workspace/my app"), "P;Cwd=")), "/workspace/my app");
	assert.equal(commandFinished(130), "\x1b]633;D;130\x07");
	assert.equal(commandFinished(), "\x1b]633;D\x07");
});

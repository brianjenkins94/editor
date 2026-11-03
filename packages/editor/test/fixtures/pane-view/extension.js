// A pane view from outside the editor (test/pane-views.mjs): a tab of its own ("Probe") with each kind of item, placed
// by its lines (a span reference and a range in a text that ran come back with BABLR's annotations) — and items into the
// Margin.
const vscode = require("vscode");

const PROBE = "pane-probe.js";
let clicked = "";
let submitted = "";

exports.activate = (context) => {
	context.subscriptions.push(
		vscode.commands.registerCommand("probeView.paneView", (uri) => {
			if (!String(uri).endsWith(PROBE)) {
				return undefined;
			}

			return {
				"items": [
					{ "id": "hello", "at": { "lines": [0, 0] }, "content": { "markdown": `**hello**${clicked === "" ? "" : ` — clicked ${clicked}`}` }, "actions": [{ "title": "Click", "command": "probeView.clicked", "arguments": ["a"] }], "tone": "question" },
					{ "id": "x", "at": { "lines": [1, 1] }, "content": { "label": "x =", "cells": [{ "text": "1", "kind": "number" }, { "text": "22", "kind": "number" }] } },
					{ "id": "longer", "at": { "lines": [2, 2] }, "content": { "label": "longer =", "cells": [{ "text": "333", "kind": "number" }] } },
					{ "id": "typed", "at": { "lines": [3, 3] }, "content": { "label": "typed", "input": { "value": submitted, "placeholder": "type here", "submit": { "title": "Submit", "command": "probeView.submitted" } } } },
				],
				"groups": [{ "id": "step", "at": { "lines": [1, 2] }, "label": "a step", "state": "ran" }],
				"marks": [{ "at": { "lines": [1, 1] }, "kind": "ran", "title": "ran twice" }]
			};
		}),
		vscode.commands.registerCommand("probeInto.paneView", (uri) => (String(uri).endsWith(PROBE) ? { "items": [{ "id": "into", "at": { "lines": [0, 0] }, "content": { "markdown": "into the margin" } }] } : undefined)),
		vscode.commands.registerCommand("probeView.clicked", async (what) => {
			clicked = what;
			await vscode.commands.executeCommand("editor.pane.refresh", "probeView");
		}),
		vscode.commands.registerCommand("probeView.submitted", async (value) => {
			submitted = value;
			await vscode.commands.executeCommand("editor.pane.refresh", "probeView");
		})
	);
};

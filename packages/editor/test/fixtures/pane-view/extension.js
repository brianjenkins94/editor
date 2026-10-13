// A pane view from outside the editor (test/pane-views.mjs): a tab of its own ("Probe") with each kind of item, placed
// each way an item can be — lines, a span reference, a range in a text that ran — and items into the Margin.
const vscode = require("vscode");

const PROBE = "pane-probe.js";
let clicked = "";
let submitted = "";
/** The text the probe "ran", as a debugger would report it: its ranges are followed from it to the file as it is. */
let ranText;
let ref;

exports.activate = (context) => {
	context.subscriptions.push(
		vscode.commands.registerCommand("probeView.paneView", async (uri) => {
			if (!String(uri).endsWith(PROBE)) {
				return undefined;
			}

			const document = vscode.workspace.textDocuments.find((each) => each.uri.toString() === uri);
			const text = document?.getText() ?? "";

			ranText ??= text;

			const start = ranText.indexOf("const later");

			if (ref === undefined) {
				const zAt = text.indexOf("const z");

				// eslint-disable-next-line require-atomic-updates -- a cache: a call that overlaps refers the same span again, either answer will do
				[ref] = await vscode.commands.executeCommand("editor.annotations.refer", text, vscode.workspace.asRelativePath(document.uri, false), [{ "start": zAt, "end": text.indexOf(";", zAt) + 1 }]) ?? [];
			}

			return {
				"items": [
					{ "id": "hello", "at": { "lines": [0, 0] }, "content": { "markdown": `**hello**${clicked === "" ? "" : ` — clicked ${clicked}`}` }, "actions": [{ "title": "Click", "command": "probeView.clicked", "arguments": ["a"] }], "tone": "question" },
					{ "id": "x", "at": { "lines": [1, 1] }, "content": { "label": "x =", "cells": [{ "text": "1", "kind": "number" }, { "text": "22", "kind": "number" }] } },
					{ "id": "longer", "at": { "lines": [2, 2] }, "content": { "label": "longer =", "cells": [{ "text": "333", "kind": "number" }] } },
					{ "id": "typed", "at": { "lines": [3, 3] }, "content": { "label": "typed", "input": { "value": submitted, "placeholder": "type here", "submit": { "title": "Submit", "command": "probeView.submitted" } } } },
					...start === -1 ? [] : [{ "id": "ran", "at": { "ran": { "source": ranText, "start": start, "end": start + "const later".length } }, "content": { "markdown": "followed from the run" } }],
					...ref === undefined ? [] : [{ "id": "ref", "at": { "ref": ref }, "content": { "markdown": "on its span" } }]
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

/**
 * Pane views (EXTENSION-POINTS.md, 4 in brianjenkins94/editor): a tab in the pane beside every editor, whose content an
 * extension provides as data — drawn by the editor level with the code it's about, in the pane's one look, and moving
 * with it.
 *
 * - Declare a view in your manifest: `"contributes": { "paneViews": [{ "id": "myView", "label": "My view", "title": … }] }`
 *   — or `"into": "margin"` to add to the editor's Margin rather than have a tab of your own.
 * - Provide it with the command `<id>.paneView`: the editor runs it with a file's URI (a string) whenever the view is
 *   shown, the file is, or the file changes, and draws the `PaneContent` it answers (or nothing, for `undefined`).
 * - Tell the editor it changed with `refreshPane(vscode.commands, id, uri?)` — every file's, or one's.
 *
 * Each item says where it is (`at`), and the editor works out the lines that is now — so it follows its code through
 * edits and reformats: a line range in the file as it is, a span reference (`./annotations`'s `refer`), or an offset
 * range in a text that ran (what a debugger reports). A provider never computes lines from a text that ran itself.
 */

import type { SpanRef } from "@brianjenkins94/util/silo/annotations";

/** VS Code's command shape: run on a click — `disabled`, shown but not offered (its `tooltip` says why). */
export interface PaneCommand { "title": string; "command": string; "arguments"?: unknown[]; "tooltip"?: string; "disabled"?: boolean }

/** A button: a command, and — `more` — a menu beside it of the ways it can go (Allow: this call, this run, always). */
export type PaneAction = PaneCommand & { "more"?: PaneCommand[] };

/** Where an item is: lines (0-based, inclusive) in the file as it is now; a span reference, followed as the code moves; or
 *  `[start, end)` offsets in `source`, a text that ran, followed from it to the file as it is now. */
export type PaneAt = { "lines": [number, number] } | { "ref": SpanRef } | { "ran": { "source": string; "start": number; "end": number } };

/** A cell of a row: its text, styled by its kind (a value's type; `branch` the arm a condition took; `set` a value set
 *  by hand or a rule; `skip` a call skipped; `given` what a rule gives in a value's place); `title` on hover; `command`
 *  run on a click; `picked` drawn held. */
export interface PaneCell { "text": string; "kind"?: "number" | "string" | "boolean" | "object" | "error" | "undefined" | "branch" | "set" | "skip" | "given"; "title"?: string; "command"?: PaneCommand; "picked"?: boolean }

/** What an item shows: prose; a row — `lead` cells before its label (a picker: ‹ 2/5 ›), its label, `value` the line's
 *  own value, then `cells` (rows on lines next to each other line these up in columns: a turn of a loop each); or one
 *  line typed in (submitted to `submit` with the text as its last argument). */
export type PaneItemContent =
	| { "markdown": string }
	| { "label"?: string; "lead"?: PaneCell[]; "value"?: PaneCell; "cells": PaneCell[] }
	| { "label": string; "input": { "value": string; "placeholder"?: string; "submit": PaneCommand } };

/** An item beside the code: `actions` its buttons — under it, or at a row's end, shown as it's hovered; `tone` how it's
 *  marked. A click on one turns the item's buttons off until it's drawn again; a command that fails says why under it. */
export interface PaneItem { "id": string; "at": PaneAt; "content": PaneItemContent; "actions"?: PaneAction[]; "tone"?: "info" | "question" | "warning" | "error" }

/** A card drawn around the lines `at` spans, its label (and `detail`) on its border, `title` on hover; `state` how its
 *  code ran, said as `stateText` (else "ran", "partly ran", "didn't run"). */
export interface PaneGroup { "id": string; "at": PaneAt; "label": string; "detail"?: string; "title"?: string; "state"?: "ran" | "partial" | "missed"; "stateText"?: string }

/** A mark in the gutter column left of the code, on `at`'s first line: `title` on hover. */
export interface PaneMark { "at": PaneAt; "kind": "ran" | "partial" | "missed" | "crashed" | "stopped" | "rule" | "rule-uncertain"; "title"?: string }

/** What a view shows of a file. */
export interface PaneContent { "items": PaneItem[]; "groups"?: PaneGroup[]; "marks"?: PaneMark[] }

/** A view, as a manifest declares it (`contributes.paneViews`). */
export interface PaneViewDeclaration { "id": string; "label"?: string; "title"?: string; "into"?: string }

/** What runs the command: an extension's `vscode.commands`. */
interface Commands { "executeCommand": <T>(command: string, ...rest: unknown[]) => PromiseLike<T> }

/** Tell the editor view `view`'s content changed — `uri`'s (a file URI's string), or every file's. */
export async function refreshPane(commands: Commands, view: string, uri?: string): Promise<void> {
	await Promise.resolve(commands.executeCommand("editor.pane.refresh", view, ...uri === undefined ? [] : [uri])).catch(() => undefined);
}

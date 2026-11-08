/**
 * The run contract's `busy`: a long computation blocks the worker, so it says now and then that it's still computing
 * (tsval's `called`), and the test runner doesn't take it for stuck.
 */
import type { ObserveSite } from "@brianjenkins94/tsval";
import type ts from "typescript";
import { addObservation } from "../site-sums";
import { post, state } from "./state";

/** How often the run says it's computing (the run contract's `busy`), and when it last did. A long computation blocks
 *  this worker, so it's said from inside it — as calls are made and values go through sites (a loop with no calls of
 *  its own), the clock looked at once in BUSY_EVERY of them. */
const BUSY_MS = 10_000;

const BUSY_EVERY = 256;

let busyTicks = 0;

let busyTold = 0;

function computing(): void {
	busyTicks += 1;

	if (busyTicks % BUSY_EVERY === 0 && performance.now() - busyTold > BUSY_MS) {
		busyTold = performance.now();
		post({ "type": "busy" });
	}
}

/** tsval's `observe`: what went through a site, added to the running timeline's sums (not a probe's: it didn't run). */
export function observeSite(node: ts.Node, site: ObserveSite, value: unknown): void {
	if (state.probing === undefined) {
		addObservation(state.recording, node, site, value);
		computing();
	}
}

/** tsval's `called`: a call began. */
export function calledSeen(): void {
	computing();
}

import type { ObserveSite } from "@brianjenkins94/tsval";
import type ts from "typescript";
import { addObservation } from "../site-sums";
import { post, state } from "./state";

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

export function observeSite(node: ts.Node, site: ObserveSite, value: unknown): void {
	if (state.probing === undefined) {
		addObservation(state.recording, node, site, value);
		computing();
	}
}

export function calledSeen(): void {
	computing();
}

/**
 * Every context reporting on the architecture plane: the realms (shared/architecture.ts), the extensions by their
 * commands (the command tap), the stores' reports.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/workbench/architecture-plane.mjs
 */
import { test } from "node:test";

import { sharedSession } from "../architecture-harness.mjs";

const session = sharedSession("architecture-plane");

test("every context reports on the architecture plane: the realms, the extensions by their commands, the stores", async () => {
	// (each reports when it's up and has something to say: all of them are waited for, not the first)
	let missing = [];

	await session.eventually("every context's report", async () => {
		const { nodes, channels } = session.seen();

		missing = [
			...["shell", "root", "sw", "workbench", "bridge"].filter((realm) => !nodes.some((node) => node.id === realm && node.state === "alive")),
			...["ext:bridge", "ext:source-control", "ext:history"].filter((extension) => !nodes.some((node) => node.id === extension)),
			...channels.some((channel) => channel.a.startsWith("ext:") && channel.b === "ext:vscode" && channel.count > 0) ? [] : ["an extension's commands"],
			...channels.some((channel) => channel.b.startsWith("store:") || channel.a.startsWith("store:")) ? [] : ["a store's traffic, by its files"]
		];

		return missing.length === 0 ? true : undefined;
	}, 60_000).catch((error) => {
		throw new Error(`${error.message}: no ${missing.join(", no ")}`);
	});
});

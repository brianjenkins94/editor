/**
 * A JS Self-Profiling trace (`new Profiler(…)` → `stop()`) as a Chrome `.cpuprofile` — the format DevTools, VS Code's
 * profile viewers, speedscope and the like open — and a summary of it: where the time went, by function.
 *
 * The trace is interned: `frames` (a function, its script and position), `stacks` (a frame and its parent stack) and
 * `samples` (a time and the stack running then, or none — idle). A `.cpuprofile` is a call tree: each node a frame
 * under its caller, with the samples that landed on it and the time between them.
 */

/** What `Profiler.stop()` resolves to (the JS Self-Profiling API's ProfilerTrace). */
export interface ProfilerTrace {
	"resources": string[];
	"frames": { "name": string; "resourceId"?: number; "line"?: number; "column"?: number }[];
	"stacks": { "frameId": number; "parentId"?: number }[];
	"samples": { "timestamp": number; "stackId"?: number }[];
}

/** Chrome's `.cpuprofile` (DevTools Profiler.Profile): times in microseconds, lines and columns from 0. */
export interface CpuProfile {
	"nodes": { "id": number; "callFrame": { "functionName": string; "scriptId": string; "url": string; "lineNumber": number; "columnNumber": number }; "hitCount": number; "children": number[] }[];
	"startTime": number;
	"endTime": number;
	"samples": number[];
	"timeDeltas": number[];
}

/** One function in a summary: the time it was running itself (`selfMs`), and with what it called (`totalMs`). */
export interface ProfileEntry { "function": string; "url": string; "line": number; "column": number; "selfMs": number; "totalMs": number }

export function toCpuProfile(trace: ProfilerTrace): CpuProfile {
	const nodes: CpuProfile["nodes"] = [];
	const node = (functionName: string, url = "", lineNumber = -1, columnNumber = -1): number => {
		nodes.push({ "id": nodes.length + 1, "callFrame": { "functionName": functionName, "scriptId": "0", "url": url, "lineNumber": lineNumber, "columnNumber": columnNumber }, "hitCount": 0, "children": [] });

		return nodes.length;
	};
	const root = node("(root)");
	const idle = node("(idle)");
	/** A frame under a node, once: `parent:frame` → its node. */
	const childOf = new Map<string, number>();
	/** Each stack's node (stacks only ever extend their parent, so each maps to one path). */
	const ofStack = new Map<number, number>();

	nodes[root - 1].children.push(idle);

	const nodeOf = (stackId: number): number => {
		const known = ofStack.get(stackId);

		if (known !== undefined) {
			return known;
		}

		const stack = trace.stacks[stackId];
		const parent = stack.parentId === undefined ? root : nodeOf(stack.parentId);
		const key = parent + ":" + stack.frameId;
		let id = childOf.get(key);

		if (id === undefined) {
			const frame = trace.frames[stack.frameId];

			// The trace's lines and columns count from 1; a .cpuprofile's, from 0.
			id = node(frame.name || "(anonymous)", frame.resourceId === undefined ? "" : trace.resources[frame.resourceId] ?? "", (frame.line ?? 0) - 1, (frame.column ?? 0) - 1);
			childOf.set(key, id);
			nodes[parent - 1].children.push(id);
		}

		ofStack.set(stackId, id);

		return id;
	};

	const samples: number[] = [];
	const timeDeltas: number[] = [];
	let previous = trace.samples[0]?.timestamp ?? 0;

	for (const sample of trace.samples) {
		const id = sample.stackId === undefined ? idle : nodeOf(sample.stackId);

		nodes[id - 1].hitCount += 1;
		samples.push(id);
		timeDeltas.push(Math.round((sample.timestamp - previous) * 1000));
		previous = sample.timestamp;
	}

	const start = Math.round((trace.samples[0]?.timestamp ?? 0) * 1000);

	return { "nodes": nodes, "startTime": start, "endTime": Math.round(previous * 1000), "samples": samples, "timeDeltas": timeDeltas };
}

/** Where `profile`'s time went, by function (name, script and line together), busiest first by self time — the `top` of
 *  them — and how long it covered. A sample's time is the gap to the next one (the last's, the gap before it). Idle
 *  isn't a function: it's `idleMs`. */
export function summarize(profile: CpuProfile, top = 20): { "durationMs": number; "idleMs": number; "functions": ProfileEntry[] } {
	const byId = new Map(profile.nodes.map((entry) => [entry.id, entry]));
	const parentOf = new Map<number, number>();

	for (const entry of profile.nodes) {
		for (const child of entry.children) {
			parentOf.set(child, entry.id);
		}
	}

	const keyOf = (id: number): string => {
		const frame = byId.get(id)!.callFrame;

		return frame.functionName + "\0" + frame.url + "\0" + frame.lineNumber + "\0" + frame.columnNumber;
	};
	const self = new Map<string, number>();
	const total = new Map<string, number>();
	let idleMs = 0;

	profile.samples.forEach((id, index) => {
		const ms = (profile.timeDeltas[index + 1] ?? profile.timeDeltas[index] ?? 0) / 1000;
		const frame = byId.get(id)!.callFrame;

		if (frame.functionName === "(idle)" || frame.functionName === "(root)") {
			idleMs += ms;

			return;
		}

		self.set(keyOf(id), (self.get(keyOf(id)) ?? 0) + ms);

		// Each function on the stack once (a recursive one would otherwise count itself again).
		const seen = new Set<string>();

		for (let at: number | undefined = id; at !== undefined && byId.get(at)!.callFrame.functionName !== "(root)"; at = parentOf.get(at)) {
			const key = keyOf(at);

			if (!seen.has(key)) {
				seen.add(key);
				total.set(key, (total.get(key) ?? 0) + ms);
			}
		}
	});

	const round = (ms: number): number => Math.round(ms * 10) / 10;
	const functions = [...self].sort((a, b) => b[1] - a[1]).slice(0, top).map(([key, ms]) => {
		const [name, url, line, column] = key.split("\0");

		return { "function": name, "url": url, "line": Number(line) + 1, "column": Number(column) + 1, "selfMs": round(ms), "totalMs": round(total.get(key) ?? ms) };
	});

	return { "durationMs": round((profile.endTime - profile.startTime) / 1000), "idleMs": round(idleMs), "functions": functions };
}

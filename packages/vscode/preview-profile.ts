/**
 * CPU profiles of an app preview's page, over the hub: the shell serves `preview.profile` — `{ window or port, durationMs,
 * sampleIntervalMs }` — and answers with a Chrome `.cpuprofile` of that window's page and a summary of where its time
 * went (cpuprofile.ts).
 *
 * It's the JS Self-Profiling API: a `Profiler` made in the preview page's own realm samples that page's main thread. A
 * Profiler can be made only in a document served with `Document-Policy: js-profiling`, which the service worker adds to
 * every preview response (coi-serviceworker.js). A docked preview shares the shell's thread (same origin), so the
 * editor's own functions can show up in its samples; the app's are the ones whose url is under the preview's
 * `/__virtual__/` path.
 *
 * And without being asked: a window that keeps running slow — much of its time in long animation frames — is profiled
 * once per slow stretch, and published on `preview.profiled` (installAutoProfiler).
 */
import type { Hub } from "@brianjenkins94/hub";
import type { CpuProfile, ProfileEntry, ProfilerTrace } from "./cpuprofile";
import { serve } from "@brianjenkins94/hub";
import { summarize, toCpuProfile } from "./cpuprofile";

/** RPC: `{ window or port, durationMs?, sampleIntervalMs?, top? }` → `{ profile, summary }`. */
export const PREVIEW_PROFILE = "preview.profile";

/** What `preview.profile` answers. */
export interface PreviewProfile {
	"profile": CpuProfile;
	"summary": { "durationMs": number; "idleMs": number; "functions": ProfileEntry[] };
}

type ProfilerConstructor = new (options: { "sampleInterval": number; "maxBufferSize": number }) => { "stop": () => Promise<ProfilerTrace> };

/** Profile `page` for `durationMs`: its `.cpuprofile` and where its time went. */
async function capture(page: Window, durationMs: number, sampleIntervalMs: number, top: number): Promise<PreviewProfile> {
	const Profiler = (page as Window & { "Profiler"?: ProfilerConstructor }).Profiler;

	if (Profiler === undefined) {
		throw new Error("this browser has no JS Self-Profiling (Profiler): Chromium has it");
	}

	const duration = Math.min(Math.max(durationMs, 100), 60_000);
	let profiler: InstanceType<ProfilerConstructor>;

	try {
		profiler = new Profiler({ "sampleInterval": Math.max(1, sampleIntervalMs), "maxBufferSize": Math.ceil(duration / Math.max(1, sampleIntervalMs)) * 2 });
	} catch (error) {
		// Not allowed: the page came before the service worker served its document with the policy.
		throw new Error("the preview's page can't be profiled (" + String(error) + "): reload it, so it's served with the profiling policy", { "cause": error });
	}

	await new Promise((resolve) => { setTimeout(resolve, duration); });

	const profile = toCpuProfile(await profiler.stop());

	return { "profile": profile, "summary": summarize(profile, top) };
}

/** Serve `preview.profile` for each preview window — `pageOf` finds its page, docked or popped out. */
export function installPreviewProfiler(hub: Hub, pageOf: (key: string) => Window | undefined): void {
	serve(hub, PREVIEW_PROFILE, async (args) => {
		const { window: named, port, durationMs = 5000, sampleIntervalMs = 10, top = 25 } = (args ?? {}) as { "window"?: unknown; "port"?: unknown; "durationMs"?: number; "sampleIntervalMs"?: number; "top"?: number };
		// A window by its key (`5173`, `5173~2` — a port's second window), or a port (its first window).
		const key = typeof named === "string" ? named : typeof port === "number" ? String(port) : undefined;

		if (key === undefined) {
			throw new Error("preview.profile takes { window or port }");
		}

		const page = pageOf(key);

		if (page === undefined) {
			throw new Error("no preview window " + key);
		}

		return await capture(page, durationMs, sampleIntervalMs, top);
	});
}

/** `preview.profiled`: a preview window ran slow, so it was profiled — `{ window, port, profile, summary }`. */
export const PREVIEW_PROFILED = "preview.profiled";

/** How slow is slow: this share of the time in long animation frames, in each of SLOW_WINDOWS windows in a row. */
const SLOW_SHARE = 0.3;
const WINDOW_MS = 2000;
const SLOW_WINDOWS = 2;
/** A window's profiles are this far apart at least: one slow stretch, one profile. */
const COOLDOWN_MS = 120_000;
const CAPTURE_MS = 5000;

/**
 * Profile a preview when it runs slow, without being asked: each window's page is watched for long animation frames, and
 * when its own scripts take more than SLOW_SHARE of the time, window after window, it's profiled for CAPTURE_MS and the
 * result published on `preview.profiled` (the workbench keeps it with the window's run). `windows` lists the open ones.
 *
 * Long animation frames are reported to the top-level window only — never to an iframe's — so they're observed in this
 * window (the docked previews' frames) and in each popped-out preview's own window, and each frame's script time is
 * credited to the page whose scripts they were (a script timing's `window`).
 */
export function installAutoProfiler(hub: Hub, windows: () => { "key": string; "port": number; "page": Window | undefined }[]): void {
	/** Each page's script time in long frames this window, and its slow windows in a row. */
	const longMs = new WeakMap<Window, number>();
	const slowRun = new WeakMap<Window, number>();
	const observed = new WeakSet<Window>();
	const lastProfiled = new Map<string, number>();
	let capturing = false;

	type ScriptTiming = { "duration": number; "window"?: Window | null };
	const observeTop = (top: Window): void => {
		if (observed.has(top)) {
			return;
		}

		observed.add(top);

		try {
			new (top as Window & typeof globalThis).PerformanceObserver((list) => {
				for (const entry of list.getEntries()) {
					for (const script of (entry as PerformanceEntry & { "scripts"?: ScriptTiming[] }).scripts ?? []) {
						if (script.window !== undefined && script.window !== null) {
							longMs.set(script.window, (longMs.get(script.window) ?? 0) + script.duration);
						}
					}
				}
			}).observe({ "type": "long-animation-frame", "buffered": false });
		} catch {
			// No long-animation-frame timing here (not Chromium): nothing to watch.
		}
	};

	observeTop(window);

	// One at a time: a profile's own sampling shouldn't be what makes another window look slow.
	const profile = async (key: string, port: number, page: Window): Promise<void> => {
		capturing = true;

		try {
			hub.publish(PREVIEW_PROFILED, { "window": key, "port": port, ...await capture(page, CAPTURE_MS, 10, 25) });
		} catch {
			// The page went away, or can't be profiled (served before the policy): nothing to report.
		} finally {
			capturing = false;
		}
	};

	setInterval(() => {
		const now = Date.now();

		for (const { key, port, page } of windows()) {
			if (page === undefined) {
				continue;
			}

			// A popped-out window is a top-level window of its own: its frames are reported there.
			if (page.top === page) {
				observeTop(page);
			}

			const slow = !page.document.hidden && (longMs.get(page) ?? 0) / WINDOW_MS >= SLOW_SHARE;
			const run = slow ? (slowRun.get(page) ?? 0) + 1 : 0;

			longMs.set(page, 0);
			slowRun.set(page, run);

			if (run >= SLOW_WINDOWS && !capturing && now - (lastProfiled.get(key) ?? 0) >= COOLDOWN_MS) {
				lastProfiled.set(key, now);
				slowRun.set(page, 0);
				void profile(key, port, page);
			}
		}
	}, WINDOW_MS);
}

/**
 * CPU profiles of a preview window's page: asked for (its title bar's Profile button, or `preview.profile` over the hub,
 * which agents use) and, without being asked, when it keeps running slow. Each is published on `preview.profiled`, with
 * why, for the workbench to keep as a `.cpuprofile` mapped back to the lines you wrote (workbench/profile-files.ts) and say
 * where its time went (extensions/insights/profiles.ts).
 *
 * It's the JS Self-Profiling API: a `Profiler` made in the preview page's own realm samples that page's thread. A
 * Profiler can be made only in a document served with `Document-Policy: js-profiling`, which the service worker adds to
 * every preview response (coi-serviceworker.js). A preview shares the shell's thread (same origin), so the editor's own
 * functions can show up in its samples; the app's are the ones whose url is under the preview's `/__virtual__/` path.
 */
import type { CpuProfile, ProfileEntry, ProfilerTrace } from "@brianjenkins94/editor-api/cpuprofile";
import type { Hub } from "@brianjenkins94/hub";
import { summarize, toCpuProfile } from "@brianjenkins94/editor-api/cpuprofile";
import { serve } from "@brianjenkins94/hub";
import { logger } from "@brianjenkins94/util/logger";

const log = logger({ "source": "shell" });

/** `preview.profiled`: a preview window's page was profiled — `{ window, port, page, why, profile, summary }`. */
export const PREVIEW_PROFILED = "preview.profiled";
/** RPC: `{ window or port, durationMs? }` → where its time went (`summary`); the profile is published as an asked one. */
export const PREVIEW_PROFILE = "preview.profile";

/** Why a page was profiled: you asked, or it kept running slow. */
export type ProfiledWhy = "asked" | "slow";

export interface PreviewProfiled {
	"window": string;
	"port": number;
	/** The page's address (its path), whose dev server's modules its frames are: an absolute import (`/src/main.ts`)
	 *  isn't under it, but the service worker sends it to the server as the page asked. */
	"page": string;
	"why": ProfiledWhy;
	"profile": CpuProfile;
	"summary": { "durationMs": number; "idleMs": number; "functions": ProfileEntry[] };
}

/** A window the profiler can find: its key (`5173~2`), its server's port, and its page. */
export interface ProfiledWindow { "key": string; "port": number; "page": Window }

/** How long a profile samples, unless asked for longer. */
export const PROFILE_MS = 5000;
const SAMPLE_MS = 10;

type ProfilerConstructor = new (options: { "sampleInterval": number; "maxBufferSize": number }) => { "stop": () => Promise<ProfilerTrace> };

/** Profile `page` for `durationMs`: its `.cpuprofile` and where its time went. */
async function capture(page: Window, durationMs: number): Promise<Pick<PreviewProfiled, "profile" | "summary">> {
	const { Profiler } = page as Window & Partial<Record<"Profiler", ProfilerConstructor>>;

	if (Profiler === undefined) {
		throw new Error("this browser has no JS Self-Profiling (Profiler): Chromium's has it");
	}

	const duration = Math.min(Math.max(durationMs, 100), 60_000);
	let profiler: InstanceType<ProfilerConstructor>;

	try {
		profiler = new Profiler({ "sampleInterval": SAMPLE_MS, "maxBufferSize": Math.ceil(duration / SAMPLE_MS) * 2 });
	} catch (error) {
		// Not allowed: the page came before the service worker served its document with the policy.
		throw new Error(`the preview's page can't be profiled (${String(error)}): reload it, so it's served with the profiling policy`, { "cause": error });
	}

	await new Promise((resolve) => {
		setTimeout(resolve, duration);
	});

	const profile = toCpuProfile(await profiler.stop());

	return { "profile": profile, "summary": summarize(profile, 25) };
}

/** Profile a window's page, and publish it. One at a time: a profile's own sampling shouldn't be what makes another
 *  window look slow. */
export function createPreviewProfiler(hub: Hub): (window: ProfiledWindow, why: ProfiledWhy, durationMs?: number) => Promise<PreviewProfiled> {
	let going: Promise<unknown> = Promise.resolve();

	return async ({ key, port, page }, why, durationMs = PROFILE_MS) => {
		const turn = going.then(async () => log.span("editor.shell.preview-profile.capture", { "window": key, "op": why, "ms": durationMs }, async (span) => {
			const profiled: PreviewProfiled = { "window": key, "port": port, "page": page.location.pathname, "why": why, ...await capture(page, durationMs) };

			// (what it found: how much was idle, and the busiest functions by name, where it went)
			span.end({ "count": profiled.profile.nodes.length, "idleMs": profiled.summary.idleMs, "top": profiled.summary.functions.slice(0, 3).map((entry) => `${entry.function} ${entry.url.split("/").pop() ?? ""}:${String(entry.line)}`).join("; ") });
			hub.publish(PREVIEW_PROFILED, profiled);

			return profiled;
		}));

		going = turn.catch(() => undefined);

		return turn;
	};
}

/** Serve `preview.profile`: `windowOf` finds a window by its key, or a port's (or any) you used last. */
export function installPreviewProfiler(hub: Hub, profile: ReturnType<typeof createPreviewProfiler>, windowOf: (asked: { "key"?: string; "port"?: number }) => ProfiledWindow | undefined): void {
	serve(hub, PREVIEW_PROFILE, async (args) => {
		const { "window": named, port, durationMs } = (args ?? {}) as { "window"?: unknown; "port"?: unknown; "durationMs"?: unknown };
		const asked = {
			...typeof named === "string" ? { "key": named } : {},
			...typeof port === "number" ? { "port": port } : {}
		};
		const found = windowOf(asked);

		if (found === undefined) {
			throw new Error(`no preview window ${asked.key ?? (asked.port === undefined ? "is open" : `on :${String(asked.port)}`)}`);
		}

		return (await profile(found, "asked", typeof durationMs === "number" ? durationMs : PROFILE_MS)).summary;
	});
}

/** How slow is slow: this share of the time in long animation frames, in each of SLOW_WINDOWS windows in a row. */
const SLOW_SHARE = 0.3;
const WINDOW_MS = 2000;
const SLOW_WINDOWS = 2;
/** A window's profiles are this far apart at least: one slow stretch, one profile. */
const COOLDOWN_MS = 120_000;

/**
 * Profile a preview when it runs slow, without being asked: each window's page is watched for long animation frames, and
 * when its own scripts take more than SLOW_SHARE of the time, window after window, it's profiled. `windows` lists the open
 * ones.
 *
 * Long animation frames are reported to the top-level window only, never to an iframe's, so they're observed here and
 * each frame's script time is credited to the page whose scripts they were (a script timing's `window`).
 */
export function installAutoProfiler(profile: ReturnType<typeof createPreviewProfiler>, windows: () => ProfiledWindow[]): void {
	/** Each page's script time in long frames this window, and its slow windows in a row. */
	const longMs = new WeakMap<Window, number>();
	const slowRun = new WeakMap<Window, number>();
	const lastProfiled = new Map<string, number>();

	interface ScriptTiming { "duration": number; "window"?: Window | null }

	try {
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				for (const script of (entry as PerformanceEntry & { "scripts"?: ScriptTiming[] }).scripts ?? []) {
					if (script.window !== undefined && script.window !== null) {
						longMs.set(script.window, (longMs.get(script.window) ?? 0) + script.duration);
					}
				}
			}
		}).observe({ "type": "long-animation-frame", "buffered": false });
	} catch {
		return; // no long-animation-frame timing here (not Chromium): nothing to watch
	}

	setInterval(() => {
		const now = Date.now();

		for (const open of windows()) {
			const slow = !open.page.document.hidden && (longMs.get(open.page) ?? 0) / WINDOW_MS >= SLOW_SHARE;
			const run = slow ? (slowRun.get(open.page) ?? 0) + 1 : 0;

			longMs.set(open.page, 0);
			slowRun.set(open.page, run);

			if (run >= SLOW_WINDOWS && now - (lastProfiled.get(open.key) ?? 0) >= COOLDOWN_MS) {
				lastProfiled.set(open.key, now);
				slowRun.set(open.page, 0);
				// (the page went away, or can't be profiled: served before the policy; nothing to report)
				profile(open, "slow").catch(() => undefined);
			}
		}
	}, WINDOW_MS);
}

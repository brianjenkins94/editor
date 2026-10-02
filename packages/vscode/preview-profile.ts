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

		return { "profile": profile, "summary": summarize(profile, top) } satisfies PreviewProfile;
	});
}

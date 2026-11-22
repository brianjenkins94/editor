import type { CpuProfile, ProfileEntry, ProfilerTrace } from "@brianjenkins94/editor-api/cpuprofile";
import type { Hub } from "@brianjenkins94/hub";
import { summarize, toCpuProfile } from "@brianjenkins94/editor-api/cpuprofile";
import { serve } from "@brianjenkins94/hub";
import { logger } from "@brianjenkins94/util/logger";

const log = logger({ "source": "shell" });

export const PREVIEW_PROFILED = "preview.profiled";
export const PREVIEW_PROFILE = "preview.profile";

export interface PreviewProfiled {
	"window": string;
	"port": number;
	"page": string;
	"profile": CpuProfile;
	"summary": { "durationMs": number; "idleMs": number; "functions": ProfileEntry[] };
}

export interface ProfiledWindow { "key": string; "port": number; "page": Window }

export const PROFILE_MS = 5000;
const SAMPLE_MS = 10;

type ProfilerConstructor = new (options: { "sampleInterval": number; "maxBufferSize": number }) => { "stop": () => Promise<ProfilerTrace> };

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
		throw new Error(`the preview's page can't be profiled (${String(error)}): reload it, so it's served with the profiling policy`, { "cause": error });
	}

	await new Promise((resolve) => {
		setTimeout(resolve, duration);
	});

	const profile = toCpuProfile(await profiler.stop());

	return { "profile": profile, "summary": summarize(profile, 25) };
}

export function createPreviewProfiler(hub: Hub): (window: ProfiledWindow, durationMs?: number) => Promise<PreviewProfiled> {
	let going: Promise<unknown> = Promise.resolve();

	return async ({ key, port, page }, durationMs = PROFILE_MS) => {
		const turn = going.then(async () => log.span("editor.shell.preview-profile.capture", { "window": key, "ms": durationMs }, async (span) => {
			const profiled: PreviewProfiled = { "window": key, "port": port, "page": page.location.pathname, ...await capture(page, durationMs) };

			span.end({ "count": profiled.profile.nodes.length, "idleMs": profiled.summary.idleMs, "top": profiled.summary.functions.slice(0, 3).map((entry) => `${entry.function} ${entry.url.split("/").pop() ?? ""}:${String(entry.line)}`).join("; ") });
			hub.publish(PREVIEW_PROFILED, profiled);

			return profiled;
		}));

		going = turn.catch(() => undefined);

		return turn;
	};
}

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

		return (await profile(found, typeof durationMs === "number" ? durationMs : PROFILE_MS)).summary;
	});
}

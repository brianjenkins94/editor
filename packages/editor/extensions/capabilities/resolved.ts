/**
 * The code's use of its dependencies as last read, for what can have grown since (baseline.ts, lib's syncConsumer).
 */
import type { WsConsumer } from "@brianjenkins94/util/silo/detect";

/** `before`, with each package use read before its version was resolved taken as it reads now: it had nothing to grow
 *  from, so its first reading with a version is where it starts. (A clone's versions resolve in instalments, and a use
 *  read meanwhile, its version none, read as moved once it had one: every capability it reaches, grown.) */
export function resolvedSince(before: Record<string, WsConsumer> | undefined, next: Record<string, WsConsumer>): Record<string, WsConsumer> | undefined {
	if (before === undefined) {
		return undefined;
	}

	return Object.fromEntries(Object.entries(before).map(([workspace, entries]) => [workspace, Object.fromEntries(Object.entries(entries).map(([spec, entry]) => {
		const now = next[workspace]?.[spec];

		return [spec, entry.kind === "package" && entry.version === undefined && now?.version !== undefined ? now : entry];
	}))]));
}

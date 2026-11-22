import type { WsConsumer } from "@brianjenkins94/util/silo/detect";

export function resolvedSince(before: Record<string, WsConsumer> | undefined, next: Record<string, WsConsumer>): Record<string, WsConsumer> | undefined {
	if (before === undefined) {
		return undefined;
	}

	return Object.fromEntries(Object.entries(before).map(([workspace, entries]) => [workspace, Object.fromEntries(Object.entries(entries).map(([spec, entry]) => {
		const now = next[workspace]?.[spec];

		return [spec, entry.kind === "package" && entry.version === undefined && now?.version !== undefined ? now : entry];
	}))]));
}

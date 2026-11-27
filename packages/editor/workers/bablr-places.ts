import type { Logger } from "@brianjenkins94/util/logger";
import type { SpanShape } from "@brianjenkins94/util/silo/annotations";

export interface Anchor { "type": string | null; "start": number; "end": number; "id": string }

export interface Places { "anchors": Anchor[]; "tokens": [number, number, string][] }

export type Placing = ({ "places": Places } | { "why": string }) & { "blob": string };

export interface CstSpan { "type": string | null; "start": number; "end": number; "token": boolean; "trivia": boolean; "text"?: string }

export interface Kept {
	"get": (key: string) => Promise<ArrayBuffer | undefined>;
	"put": (key: string, bytes: ArrayBuffer) => Promise<void>;
}

const HELD = 64;

export async function blobOid(text: string): Promise<string> {
	const body = new TextEncoder().encode(text);
	const header = new TextEncoder().encode(`blob ${String(body.length)}\0`);
	const bytes = new Uint8Array(header.length + body.length);

	bytes.set(header);
	bytes.set(body, header.length);

	return [
		...new Uint8Array(await crypto.subtle.digest("SHA-1", bytes))
	].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function placesOf(anchors: readonly Anchor[], spans: readonly CstSpan[]): Places {
	return {
		"anchors": anchors.map(({ type, start, end, id }) => ({
			"type": type,
			"start": start,
			"end": end,
			"id": id
		})),
		"tokens": spans.filter((span) => span.token && !span.trivia).toSorted((left, right) => left.start - right.start).map((span): [number, number, string] => [span.start, span.end, span.text ?? ""])
	};
}

export function shapesOf({ anchors, tokens }: Places): SpanShape[] {
	const firstAt = (offset: number): number => {
		let low = 0;
		let high = tokens.length;

		while (low < high) {
			const middle = (low + high) >> 1;

			if (tokens[middle][0] < offset) {
				low = middle + 1;
			} else {
				high = middle;
			}
		}

		return low;
	};

	return anchors.filter((span): span is Anchor & { "type": string } => span.type !== null).map((span) => {
		const atoms: string[] = [];

		for (let at = firstAt(span.start); at < tokens.length && tokens[at][1] <= span.end; at += 1) {
			atoms.push(tokens[at][2]);
		}

		return {
			"id": span.id,
			"type": span.type,
			"start": span.start,
			"end": span.end,
			"atoms": atoms
		};
	});
}

export async function pack(value: unknown): Promise<ArrayBuffer> {
	return new Response(new Blob([
		JSON.stringify(value)
	]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
}

export async function unpack<T>(bytes: ArrayBuffer): Promise<T> {
	return JSON.parse(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text()) as T;
}

export function placer({ version, kept, place, log }: {
	"version": string;
	"kept": Kept;
	"place": (source: string, signal: AbortSignal) => Promise<{ "places": Places } | { "why": string }>;
	"log": Logger;
}): (source: string, signal: AbortSignal) => Promise<Placing> {
	const held = new Map<string, Placing>();
	const hold = (key: string, placing: Placing): Placing => {
		held.delete(key);
		held.set(key, placing);

		for (const oldest of [
			...held.keys()
		].slice(0, Math.max(0, held.size - HELD))) {
			held.delete(oldest);
		}

		return placing;
	};

	return async (source, signal) => {
		const blob = await blobOid(source);
		const key = version + "/" + blob;
		const known = held.get(key);

		if (known !== undefined) {
			return hold(key, known);
		}

		return log.span("editor.workers.bablr-places.place", { "bytes": source.length }, async (span) => {
			const bytes = await kept.get(key).catch(() => undefined);

			if (bytes !== undefined) {
				const placing = await unpack<Placing>(bytes).catch(() => undefined);

				if (placing !== undefined) {
					span.end({ "cached": true, "kept": bytes.byteLength });

					return hold(key, placing);
				}
			}

			const placing = {
				...await place(source, signal),
				"blob": blob
			};
			const packed = await pack(placing);

			await kept.put(key, packed).catch(() => undefined);
			span.end({ "cached": false, "kept": packed.byteLength });

			return hold(key, placing);
		});
	};
}

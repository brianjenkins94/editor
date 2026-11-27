import type { SpanShape } from "@brianjenkins94/util/silo/annotations";

export interface ParsedNode { "type": string | null; "start": number; "end": number; "id": string; "text": string | null }

export type Parse = ({ "nodes": ParsedNode[]; "comments": number[] } | { "why": string }) & { "blob": string };

export interface CstSpan { "type": string | null; "start": number; "end": number; "token": boolean; "trivia": boolean; "text"?: string | null }

export interface Kept {
	"get": (key: string) => Promise<ArrayBuffer | undefined>;
	"put": (key: string, bytes: ArrayBuffer) => Promise<void>;
}

export interface Spans { "span": <T>(name: string, attrs: Record<string, number | string | boolean>, run: (span: { "end": (attrs?: Record<string, number | string | boolean>) => void }) => T) => T }

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

export function parseOf(anchors: readonly { "type": string | null; "start": number; "end": number; "id": string }[], spans: readonly CstSpan[]): { "nodes": ParsedNode[]; "comments": number[] } {
	const code = spans.filter((span) => !span.trivia);

	return {
		"nodes": anchors.map(({ type, start, end, id }, index) => ({
			"type": type,
			"start": start,
			"end": end,
			"id": id,
			"text": code[index]?.text ?? null
		})),
		"comments": spans.filter((span) => span.type === "Comment").flatMap((span) => [span.start, span.end])
	};
}

export function spansOf({ nodes }: { "nodes": readonly ParsedNode[] }): { "spans": CstSpan[] } {
	return {
		"spans": nodes.map((node) => ({
			...node,
			"token": node.text !== null,
			"trivia": false
		}))
	};
}

export function shapesOf({ nodes }: { "nodes": readonly ParsedNode[] }): SpanShape[] {
	const tokens = nodes.filter((node) => node.text !== null).toSorted((left, right) => left.start - right.start);
	const firstAt = (offset: number): number => {
		let low = 0;
		let high = tokens.length;

		while (low < high) {
			const middle = (low + high) >> 1;

			if (tokens[middle].start < offset) {
				low = middle + 1;
			} else {
				high = middle;
			}
		}

		return low;
	};

	return nodes.filter((node): node is ParsedNode & { "type": string } => node.type !== null).map((node) => {
		const atoms: string[] = [];

		for (let at = firstAt(node.start); at < tokens.length && tokens[at].end <= node.end; at += 1) {
			atoms.push(tokens[at].text ?? "");
		}

		return {
			"id": node.id,
			"type": node.type,
			"start": node.start,
			"end": node.end,
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

export function parser({ version, kept, parse, log }: {
	"version": string;
	"kept": Kept;
	"parse": (source: string, signal: AbortSignal) => Promise<{ "nodes": ParsedNode[]; "comments": number[] } | { "why": string }>;
	"log": Spans;
}): (source: string, signal: AbortSignal) => Promise<Parse> {
	const held = new Map<string, Parse>();
	const hold = (key: string, parsed: Parse): Parse => {
		held.delete(key);
		held.set(key, parsed);

		for (const oldest of [
			...held.keys()
		].slice(0, Math.max(0, held.size - HELD))) {
			held.delete(oldest);
		}

		return parsed;
	};

	return async (source, signal) => {
		const blob = await blobOid(source);
		const key = version + "/" + blob;
		const known = held.get(key);

		if (known !== undefined) {
			return hold(key, known);
		}

		return log.span("editor.workers.bablr-parses.parse", { "bytes": source.length }, async (span) => {
			const bytes = await kept.get(key).catch(() => undefined);
			const found = bytes === undefined
				? undefined
				: await unpack<Parse>(bytes).catch(() => undefined);

			if (found !== undefined) {
				span.end({ "cached": true, "kept": bytes?.byteLength ?? 0 });

				return hold(key, found);
			}

			const parsed = {
				...await parse(source, signal),
				"blob": blob
			};
			const packed = await pack(parsed);

			await kept.put(key, packed).catch(() => undefined);
			span.end({ "cached": false, "kept": packed.byteLength });

			return hold(key, parsed);
		});
	};
}

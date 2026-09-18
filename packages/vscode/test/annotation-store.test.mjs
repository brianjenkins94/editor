// Spec for how the annotation subsystem persists — the design settled with the user, pinned as executable tests.
// Two independent pieces:
//   1. The `.ts.bablr` CACHE is CONTENT-ADDRESSED (keyed by the content's blob oid, flat in .git/bablr/), so a file
//      moving or being renamed is a non-problem (the key is the content, not the path) and editing content naturally
//      mints a new entry. It's a derivable cache of spanAnchors(content) — a miss just re-derives.
//   2. ANNOTATIONS are path-scoped but MIGRATE by following their span ids: when a scope's path disappears (rename) or
//      no longer holds the annotated spans, they re-home to the current file holding the most of those (content-
//      addressed) ids — which even survives a span cut into a different file. Git has no stable file identity, so this
//      is git's own content-similarity approach, made precise by keying on the spans themselves.
// Run: node --test (against the built bablr dist).
import assert from "node:assert/strict";
import test from "node:test";
// eslint-disable-next-line antfu/no-import-dist -- exercise the shipped artifact (dist is gitignored, local/CI-built)
import { spanAnchors } from "../../bablr/dist/index.js";

// Stand-in for a content-addressed key (the real engine uses the git blob oid via isomorphic-git hashBlob). Only the
// "same content ⇒ same key, different content ⇒ different key" property matters here.
const contentKey = (text) => { let h = 0xcbf29ce4n; for (let i = 0; i < text.length; i += 1) { h = ((h ^ BigInt(text.charCodeAt(i))) * 0x100000001b3n) & 0xffffffffffffffffn; } return h.toString(16); };
const stmtId = (content, text) => spanAnchors(content).find((anchor) => anchor.type === "Statement" && content.slice(anchor.start, anchor.end).trim() === text)?.id;

const FOO = "const a = 1;\nconst bottom = 2;\nconst c = 3;\n";

test("cache is content-addressed: reopen hits, a move reuses the entry, an edit mints a new one", () => {
	const cache = new Map();
	let derives = 0;
	const anchorsOf = (content) => { const key = contentKey(content); if (cache.has(key)) return cache.get(key); derives += 1; const anchors = spanAnchors(content); cache.set(key, anchors); return anchors; };

	anchorsOf(FOO); // miss → derive
	anchorsOf(FOO); // reopen unchanged → hit
	assert.equal(derives, 1, "reopening unchanged content is a cache hit");

	anchorsOf(FOO); // "same content at a different path" → same key, still one derive
	assert.equal(derives, 1, "a file moved to a new path (same content) reuses the entry — no path→sidecar mapping");

	anchorsOf("const a = 1;\nconst bottom = 22;\nconst c = 3;\n"); // edit → new key
	assert.equal(derives, 2, "editing content mints a new entry (old one stale / GC-able)");
	assert.notEqual(contentKey(FOO), contentKey("const a = 1;\nconst bottom = 22;\nconst c = 3;\n"), "content change ⇒ different key");
});

// Re-home each annotation scope whose path is gone (or no longer holds its spans) to the current file with the most of
// its annotated span ids. Returns the migrated { path: { spanId: note } }.
function migrate(annotations, files) {
	const present = new Set(Object.keys(files));
	const idsByPath = Object.fromEntries(Object.entries(files).map(([path, content]) => [path, new Set(spanAnchors(content).map((anchor) => anchor.id))]));
	const out = {};

	for (const [oldPath, notes] of Object.entries(annotations)) {
		if (present.has(oldPath) && Object.keys(notes).some((id) => idsByPath[oldPath].has(id))) {
			out[oldPath] = { ...out[oldPath], ...notes };

			continue;
		}

		const ids = Object.keys(notes);
		let best;
		let score = 0;

		for (const [path, set] of Object.entries(idsByPath)) {
			const overlap = ids.filter((id) => set.has(id)).length;

			if (overlap > score) { score = overlap; best = path; }
		}

		const target = best !== undefined && score > 0 ? best : oldPath;

		out[target] = { ...out[target], ...notes };
	}

	return out;
}

const resolvesEverywhere = (annotations, files) => Object.entries(annotations).every(([path, notes]) => { const set = new Set(spanAnchors(files[path] ?? "").map((anchor) => anchor.id)); return Object.keys(notes).every((id) => set.has(id)); });

test("annotations migrate on a pure rename and resolve against the new path", () => {
	const bottomId = stmtId(FOO, "const bottom = 2");
	const migrated = migrate({ "src/foo.ts": { [bottomId]: "note" } }, { "lib/foo.ts": FOO });

	assert.ok(migrated["lib/foo.ts"]?.[bottomId], "the note re-homes from src/foo.ts to lib/foo.ts");
	assert.ok(resolvesEverywhere(migrated, { "lib/foo.ts": FOO }), "and resolves against the renamed file");
});

test("annotations migrate on rename + edits elsewhere (the annotated span survives)", () => {
	const bottomId = stmtId(FOO, "const bottom = 2");
	const migrated = migrate({ "src/foo.ts": { [bottomId]: "note" } }, { "lib/foo.ts": "const a = 111;\nconst bottom = 2;\nconst c = 333;\n" });

	assert.ok(migrated["lib/foo.ts"]?.[bottomId], "re-homes because the span id is still present despite other edits");
});

test("annotations follow a span CUT into a different file (content-addressed safety net)", () => {
	const bottomId = stmtId(FOO, "const bottom = 2");
	const migrated = migrate({ "src/foo.ts": { [bottomId]: "note" } }, { "src/foo.ts": "const a = 1;\nconst c = 3;\n", "src/bar.ts": "const bottom = 2;\n" });

	assert.ok(migrated["src/bar.ts"]?.[bottomId], "re-homes to bar.ts, where the span now lives — even though foo.ts still exists");
});

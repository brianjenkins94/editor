/**
 * The game-maker PROJECTION model — plain, JSON-serialisable data the game-worker extracts from a project's CST
 * and posts to the (BABLR-free) game-view for rendering. No runtime imports here on purpose: the view imports
 * only these types, so nothing pulls the BABLR parser into the workbench bundle (it lives in the worker).
 *
 * Every element that maps back to a single source node carries its `[start, end)` span in the file it came from,
 * so painting/editing a projected element is a surgical replacement of that node's text (write-back).
 */

/** A source range `[start, end)` in a specific file (workspace-absolute path). */
export interface Span { "file": string; "start": number; "end": number }

/** A file's identity snapshot — BABLR's per-file `Snapshot` (nodes in file order, each with its stable id + atom).
 *  This is the re-derivable `.ts.bablr` index content AND the `reidentify` baseline that carries ids across edits. */
export interface IdSnapshot { "nodes": { "id": string; "atom": string }[] }

/** A tileset image: its name and URL (data: or http). gid → tilesets[gid - 1] (firstgid = index + 1). */
export interface Tileset { "name": string; "url": string }

/** One placed tile: its gid at tile coords (tx, ty), the source span of the gid literal (for write-back), and the
 *  stable BABLR node id of that literal (for durable anchoring of data to this cell). */
export interface PlacedTile { "gid": number; "tx": number; "ty": number; "span"?: Span; "nodeId"?: string }

/** A layer: an optional whole-layer `fill` gid plus explicitly placed tiles (from bitblt / object placements). */
export interface Layer { "name": string; "isObjectLayer": boolean; "fill"?: number; "tiles": PlacedTile[] }

/** The level (a Tilemap builder file), projected. */
export interface Level {
	"file": string;
	"width": number;
	"height": number;
	"tileW": number;
	"tileH": number;
	"tilesets": Tileset[];
	"layers": Layer[];
}

/** An ECS component: a tag (no data), a data component (named fields), or an enum (a numeric constant object).
 *  `nodeId` is its declaration's stable BABLR node id (durable anchor). */
export interface Component { "name": string; "kind": "tag" | "data" | "enum"; "fields": string[]; "nodeId"?: string }

/** One object type's spawn wiring from game.ts's load() config: its components + render depth + node id. */
export interface EntityType { "name": string; "components": string[]; "depth"?: number; "nodeId"?: string }

/** One system in execution order: its queries + body source + the stable node id of its entry in the systems
 *  array (the anchor an event-sheet row / breakpoint / disposition pins to). */
export interface System { "name": string; "queries": string[][]; "body": string; "nodeId"?: string }

/** The whole projection of a game project, as the worker returns it. Any part may be absent (missing files).
 *  `nodeLines` maps stable node id → 1-based line (merged across the project's files), so a node resolves to its
 *  current line and, inverted, a line resolves to the node(s) on it — the id↔line spine. */
export interface GameProjection {
	"level"?: Level;
	"components": Component[];
	"objects": EntityType[];
	"systems": System[];
	"nodeLines": Record<string, number>;
	/** The identity snapshot each parsed file produced (path → snapshot) — the worker rolls these forward as the
	 *  `reidentify` baseline, and they're the content of the re-derivable `.ts.bablr` index. */
	"snapshots": Record<string, IdSnapshot>;
}

/** The file set the client hands the worker to project (all workspace-absolute paths + contents). */
export interface ProjectSources {
	/** The level file the view is focused on (a Tilemap builder file), if any. */
	"levelFile"?: string;
	"levelCode"?: string;
	/** game.ts path + contents (carries the load() config + the systems array). */
	"gameFile"?: string;
	"gameCode"?: string;
	/** schemas/*.ts — component definitions, by path. */
	"schemas": { "file": string; "code": string }[];
	/** systems/*.ts — system bodies, by path. */
	"systems": { "file": string; "code": string }[];
	/** Prior identity snapshots read from the `.ts.bablr` sidecars (path → snapshot) — the reidentify baseline, so
	 *  ids carry across edits and survive a worker restart. Empty on first open (bootstrap). */
	"priorSnapshots": Record<string, IdSnapshot>;
}

/**
 * What a preview's pages report (previews/page-evidence.ts records it), as the realms that read it have it: runtime
 * evidence (workbench/evidence.ts), recorded stops (workbench/recorded-stops.ts), and the replays the debugger steps
 * (the bridge's replay.ts, tsval's replay-run.ts).
 */
import type { SiteObservation, StatementCoverage } from "@brianjenkins94/editor-api";
import type { Encoded } from "@brianjenkins94/editor-api/recorded";

/** What one version of a module observed in a page: its file and version, each statement with its count, each site
 *  that ran — positions in the module's original source. */
export interface ModuleEvidence { "file": string; "version": string; "statements": StatementCoverage[]; "sites": SiteObservation[] }

/** One time a recorded stop's line ran: which time, the event the page was handling, and each name in scope with its
 *  value previewed then (`this` among them, when it's something). */
export interface StopHit { "n": number; "event"?: string; "values": [string, string][]; "replay"?: Replay }

/** A recorded call of the function a stop is in, to step afterwards (RUNNING.md: stepping a recorded handler): its range,
 *  what it read from outside itself (`free`), `this` and its arguments on entry, and each call's result where it was made
 *  (0-based line and character, the nth time there) — encoded (snapshot.ts). */
export interface Replay { "fn": [number, number, number, number]; "free": Record<string, Encoded>; "self": Encoded; "args": Encoded[]; "calls": [number, number, Encoded][] }

/** A recorded stop of a module version: its statement's range (0-based line and character), the functions it's in,
 *  and its latest hits. */
export interface RecordedStop { "file": string; "version": string; "at": [number, number, number, number]; "where": string; "hits": StopHit[] }

/** The package an esm.sh URL serves: its name, and its version when the URL names an exact one (the entry a page imports
 *  can name a range — `react@^19` — and the module it answers imports the version that resolved to: `/react@19.3.0/…`).
 *  Undefined for any other URL. Read by the page (what it loaded) and the service worker (what it may load). */
export function esmPackage(url: string): { "name": string; "version"?: string } | undefined {
	const parsed = URL.canParse(url) ? new URL(url) : undefined;
	const match = parsed?.hostname === "esm.sh" ? /^\/(?:(?:v\d+|stable)\/)?\*?((?:@[^/@]+\/)?[^/@?]+)(?:@([^/?&]+))?/u.exec(parsed.pathname) : null;

	if (match === null) {
		return undefined;
	}

	return /^\d+\.\d+\.\d/u.test(match[2] ?? "") ? { "name": match[1], "version": match[2] } : { "name": match[1] };
}

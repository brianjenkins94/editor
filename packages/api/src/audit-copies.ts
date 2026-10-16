/**
 * The audit log's locked copies (README.md, "A tamper-evident audit log"). Every row the Worker writes to D1 is also written,
 * once, to R2 (`AUDIT_COPIES`), under a prefix whose bucket lock keeps it as long as D1 keeps the row: `routine/` 90
 * days, `suspicious/` 365. A copy can't be overwritten or deleted until then, by the Worker or anyone short of the
 * Cloudflare account, so D1 can be checked against it: a row edited, a row deleted before its time, or a row never
 * copied all show. D1's ids are AUTOINCREMENT, never reused, so the id sequence is the chain.
 *
 * Pure (no Worker imports): the Worker writes copies with it, and `npm run audit -- --verify` compares with it.
 */

/** The everyday record — sign-ins and what they did — kept ROUTINE_DAYS; everything else (every refusal, every alert) is
 *  what an investigation needs most, and is kept SUSPICIOUS_DAYS. */
export const ROUTINE = ["login", "token_issued", "refreshed", "grant_revoked", "github_refresh_refused", "proxy_call"];

export const ROUTINE_DAYS = 90;

export const SUSPICIOUS_DAYS = 365;

const DAY = 86_400_000;

/** An audit row as D1 has it. */
export interface Row {
	"id": number;
	"at": number;
	"event": string;
	"user_id": string | null;
	"grant_id": string | null;
	"country": string | null;
	"ip_hash": string | null;
	"reason": string | null;
	"detail": string | null;
	"trace_id": string | null;
}

/** What a copy holds: the row as it was written, and, for a proxied call, the reason it was finished with (its bytes). */
export interface Copy { "row": Row; "finished"?: string }

/** How long an event's row is kept, and so its copy locked. */
export const keptDays = (event: string): number => (ROUTINE.includes(event) ? ROUTINE_DAYS : SUSPICIOUS_DAYS);

/** A row's copy's key: its class's prefix (which its lock and expiry rules match), then the id, padded to sort. `part`
 *  is `.finished` for the second, later object a proxied call's bytes go in. */
export const copyKey = (event: string, id: number, part = ""): string => `${ROUTINE.includes(event) ? "routine" : "suspicious"}/${String(id).padStart(12, "0")}${part}.json`;

/** The id a copy's key names, and whether it's the `.finished` part. */
export function parseKey(key: string): { "id": number; "finished": boolean } | undefined {
	const match = /^(?:routine|suspicious)\/(\d{12})(\.finished)?\.json$/u.exec(key);

	return match === null ? undefined : { "id": Number(match[1]), "finished": match[2] !== undefined };
}

const FIELDS = ["at", "event", "user_id", "grant_id", "country", "ip_hash", "reason", "detail", "trace_id"] as const;

/** What a comparison found wrong: a row edited, deleted before its time, never copied, or an id with neither row nor copy
 *  (AUTOINCREMENT leaves no gaps of its own: a row and its copy both went missing). */
export interface Finding { "id": number; "kind": "edited" | "deleted" | "not copied" | "missing"; "detail": string }

export interface Verdict {
	"findings": Finding[];
	/** Rows that match their copies. */
	"matching": number;
	/** Rows gone from D1 after their time (retention), their copies still in their lock or expiring. */
	"expired": number;
	/** Rows whose user id was taken off when the account was deleted (account.ts): the copy keeps an id nothing points at. */
	"anonymized": number;
	/** Rows older than the first copy: written before copies began. */
	"before": number;
}

/**
 * D1's rows against their copies. Every id from the first copy on must have both, the same — except a user id removed by
 * account deletion, and a proxied call's reason finished with its bytes. A row missing from D1 is fine once its class's
 * days have passed (with a day's grace for the daily cron); before that it was deleted.
 */
export function compare(rows: Row[], copies: Map<number, Copy>, now = Date.now()): Verdict {
	const verdict: Verdict = { "findings": [], "matching": 0, "expired": 0, "anonymized": 0, "before": 0 };
	const byId = new Map(rows.map((row) => [row.id, row]));
	const first = Math.min(...copies.keys());

	for (const row of rows) {
		if (!copies.has(row.id)) {
			if (copies.size === 0 || row.id < first) {
				verdict.before += 1;
			} else {
				verdict.findings.push({ "id": row.id, "kind": "not copied", "detail": `${row.event} at ${new Date(row.at).toISOString()} has no copy` });
			}
		}
	}

	for (const [id, copy] of [...copies].sort(([a], [b]) => a - b)) {
		const row = byId.get(id);

		if (row === undefined) {
			if (now - copy.row.at > (keptDays(copy.row.event) + 1) * DAY) {
				verdict.expired += 1;
			} else {
				verdict.findings.push({ "id": id, "kind": "deleted", "detail": `${copy.row.event} at ${new Date(copy.row.at).toISOString()} is gone from D1 before its ${keptDays(copy.row.event)} days` });
			}

			continue;
		}

		const expected: Row = { ...copy.row, "reason": copy.finished ?? copy.row.reason };
		const anonymized = row.user_id === null && expected.user_id !== null;
		const changed = FIELDS.filter((field) => row[field] !== expected[field] && !(field === "user_id" && anonymized));

		if (changed.length > 0) {
			verdict.findings.push({ "id": id, "kind": "edited", "detail": changed.map((field) => `${field}: ${JSON.stringify(expected[field])} → ${JSON.stringify(row[field])}`).join(", ") });
		} else if (anonymized) {
			verdict.anonymized += 1;
		} else {
			verdict.matching += 1;
		}
	}

	const last = Math.max(...copies.keys(), ...byId.keys());

	for (let id = first; copies.size > 0 && id < last; id += 1) {
		if (!copies.has(id) && !byId.has(id)) {
			verdict.findings.push({ "id": id, "kind": "missing", "detail": "neither the row nor its copy exists" });
		}
	}

	verdict.findings.sort((a, b) => a.id - b.id);

	return verdict;
}

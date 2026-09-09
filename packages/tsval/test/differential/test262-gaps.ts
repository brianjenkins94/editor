/**
 * test262 tests tsval does not pass yet, grouped by id PREFIX (a directory or file) with the reason.
 * Matching tests run as `todo`: reported, never silently passing, visible the moment they pass.
 * Keep entries as narrow as the bug they describe; remove them as fixes land.
 */
export const TEST262_KNOWN_GAPS: Record<string, string> = {
	// (empty — destructuring patterns and class computed keys now evaluate on the stepped stack)
};

/** Find the gap entry covering an id (longest matching prefix wins). */
export function knownGap(id: string): string | undefined {
	let best: string | undefined;
	let bestLen = -1;
	for (const [prefix, reason] of Object.entries(TEST262_KNOWN_GAPS)) {
		if (id.startsWith(prefix) && prefix.length > bestLen) {
			best = reason;
			bestLen = prefix.length;
		}
	}
	return best;
}

/**
 * Which context a log record is from: the one its SUBJECT names (`$sys.log.<source>`), not the `context.source` the
 * sender wrote into it. Permissions enforce the subject — a link lets a peer publish only its own `$sys.log.<id>` — so
 * the subject is the part a peer can't lie about; the tag inside the record is data. Collectors tag by subject.
 */

const PREFIX = "$sys.log.";

/** The source a `$sys.log.<source>` subject names, or undefined for another subject. */
export function sourceOfLogSubject(subject: string): string | undefined {
	return subject.startsWith(PREFIX) && subject.length > PREFIX.length ? subject.slice(PREFIX.length) : undefined;
}

/** `record`, tagged with the source its subject names, whatever it claimed (unchanged for another subject). */
export function tagBySubject<T>(record: T, subject: string): T {
	const source = sourceOfLogSubject(subject);

	if (source === undefined || typeof record !== "object" || record === null) {
		return record;
	}

	const { context } = record as { "context"?: Record<string, unknown> };

	return context?.["source"] === source ? record : { ...record, "context": { ...context, "source": source } };
}

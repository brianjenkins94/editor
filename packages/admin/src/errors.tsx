/**
 * The Errors pages (packages/api/OPERATIONS.md, "Errors"; O4): every uncaught error, grouped, most recently seen first;
 * a group's occurrences; one occurrence (by the id a person quoted, `E-ABCD-EFGH`): its stack, release, trace id and,
 * if they were signed in, whose sign-in. Messages and stacks were redacted before they were stored. `errors:read`.
 * An editor stack is mapped through its release's source maps (O7) as it's shown: each frame's file and line in the repo,
 * ours linked to GitHub at that commit.
 */
import type { SourceMapInput } from "@jridgewell/trace-mapping";
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import { useEffect, useState } from "preact/hooks";
import { get } from "./session";
import { Table, When } from "./views";

interface Group { "fingerprint": string; "source": string; "name": string; "message": string | null; "route": string | null; "first_seen": number; "last_seen": number; "count": number; "releases": string; "recent"?: number }

interface Occurrence { "id": string; "at": number; "route": string | null; "release": string | null; "trace_id": string | null; "grant_id": string | null; "user_id": string | null; "message": string | null; "stack"?: string | null; "breadcrumbs"?: string | null; "name"?: string; "source"?: string; "count"?: number; "fingerprint"?: string }

/** A read: its data (the caller says its shape), or what went wrong. */
function useGet(path: string): { "data"?: unknown; "problem"?: string } {
	const [state, setState] = useState<{ "data"?: unknown; "problem"?: string }>({});

	useEffect(() => {
		setState({});
		get(path).then((data) => {
			setState({ "data": data });
		}, (error: unknown) => {
			setState({ "problem": error instanceof Error && / 404$/u.test(error.message) ? "Not found: the id may be mistyped, or older than 30 days." : error instanceof Error && / 403$/u.test(error.message) ? "Your roles don't include this." : "Couldn't load this." });
		});
	}, [path]);

	return state;
}

const isErrorId = (text: string): boolean => /^E?[\s-]*[A-HJ-NP-Z2-9]{4}[\s-]*[A-HJ-NP-Z2-9]{4}$/iu.test(text.trim());

/** A search for the id a person quoted. */
function FindById() {
	const [problem, setProblem] = useState<string | undefined>();

	return (
		<form
			class="wa-cluster wa-gap-s wa-align-items-end"
			onSubmit={(event) => {
				event.preventDefault();

				const typed = (event.currentTarget.elements.namedItem("id") as HTMLInputElement).value;

				if (isErrorId(typed)) {
					setProblem(undefined);
					location.hash = `#/errors/${encodeURIComponent(typed.trim())}`;
				} else {
					setProblem("An error id looks like E-ABCD-EFGH.");
				}
			}}
		>
			<wa-input name="id" label="Find an error by its id" placeholder="E-ABCD-EFGH" />
			<wa-button type="submit">Find</wa-button>
			{problem !== undefined && <span class="problem">{problem}</span>}
		</form>
	);
}

/** A stack, a line each. */
function Stack({ text }: { "text": string }) {
	return <div class="wa-stack wa-gap-3xs app-code wa-caption-m">{text.split("\n").map((line, index) => <span key={index}>{line}</span>)}</div>;
}

const REPO = "https://github.com/brianjenkins94/editor";

/** A frame's script as a path in the site, and its line and column: Chrome's `at f (https://…/__vscode__/main.js:1:2)`
 *  or Firefox's `f@https://…`; the GitHub Pages copy's /editor/ base dropped. */
const FRAME = /[a-z-]+:\/\/[^/\s)]+\/(?:editor\/)?([^\s():]+\.js):(\d+):(\d+)/u;

interface Original { "source": string; "line": number; "column": number; "name": string | null }

/** A frame's place in the repo: ours (packages/, components/) linked to GitHub at the release, others as they are. */
function Place({ at, release }: { "at": Original; "release": string }) {
	const where = `${at.source}:${at.line}:${at.column + 1}`;
	const ours = /^(?:packages|components)\//u.test(at.source) && !at.source.includes("node_modules");

	return (
		<span class="wa-color-text-quiet">
			{"  → "}
			{ours ? <a href={`${REPO}/blob/${release}/${at.source}#L${at.line}`} target="_blank" rel="noreferrer">{where}</a> : where}
			{at.name === null ? "" : ` (${at.name})`}
		</span>
	);
}

/** An editor stack, each frame mapped through its release's source maps (GET /admin/errors/maps/…; kept 45 days, by
 *  production's deploys only). */
function MappedStack({ text, release }: { "text": string; "release": string }) {
	const lines = text.split("\n");
	const [mapped, setMapped] = useState<(Original | undefined)[]>([]);
	const [state, setState] = useState<"mapping" | "mapped" | "no maps">("mapping");

	useEffect(() => {
		const frames = lines.map((line) => FRAME.exec(line));
		const paths = [...new Set(frames.flatMap((frame) => (frame?.[1] === undefined ? [] : [frame[1]])))];
		let current = true;

		void Promise.all(paths.map(async (path) => [path, await get<SourceMapInput>(`/errors/maps/${encodeURIComponent(release)}/${encodeURI(path)}.map`).then((map) => new TraceMap(map), () => undefined)] as const)).then((maps) => {
			const byPath = new Map(maps);

			if (!current) {
				return;
			}

			setMapped(frames.map((frame) => {
				const map = frame?.[1] === undefined ? undefined : byPath.get(frame[1]);
				const at = map === undefined ? undefined : originalPositionFor(map, { "line": Number(frame?.[2]), "column": Number(frame?.[3]) - 1 });

				return at?.source === null || at?.source === undefined ? undefined : { "source": at.source, "line": at.line, "column": at.column, "name": at.name };
			}));
			setState(maps.some(([, map]) => map !== undefined) ? "mapped" : "no maps");
		});

		return () => {
			current = false;
		};
	}, [text, release]);

	return (
		<div class="wa-stack wa-gap-xs">
			{state === "mapping" && <span class="wa-color-text-quiet">Mapping it through release {release}'s source maps…</span>}
			{state === "no maps" && <span class="wa-color-text-quiet">Release {release}'s source maps aren't kept (only production's deploys keep them, for 45 days): the stack is as it ran.</span>}
			<div class="wa-stack wa-gap-3xs app-code wa-caption-m">
				{lines.map((line, index) => {
					const at = mapped[index];

					return (
						<div key={index} class="wa-stack wa-gap-0">
							<span>{line}</span>
							{at !== undefined && <Place at={at} release={release} />}
						</div>
					);
				})}
			</div>
		</div>
	);
}

export function ErrorsPage() {
	const read = useGet("/errors?days=7") as { "data"?: { "days": number; "errors": Group[] }; "problem"?: string };

	return (
		<section class="wa-stack wa-gap-l">
			<h1 class="wa-heading-xl">Errors</h1>
			<p class="wa-color-text-quiet">Every uncaught error in the last 7 days, grouped by its name and where in the code it happened. A person who saw one was shown its id: find it here.</p>
			<FindById />
			{read.problem !== undefined && <wa-callout variant="danger">{read.problem}</wa-callout>}
			{read.data === undefined ? read.problem === undefined && <wa-spinner /> : read.data.errors.length === 0 ? <p class="wa-color-text-quiet">None. 🎉</p> : (
				<Table head={["Error", "Where", "Last 7 days", "In all", "First seen", "Last seen", "Releases"]}>
					{read.data.errors.map((group) => (
						<tr key={group.fingerprint}>
							<td><a href={`#/errors/${group.fingerprint}`}><strong>{group.name}</strong></a> <span class="wa-color-text-quiet">{group.message}</span></td>
							<td>{group.source} · {group.route}</td>
							<td>{group.recent}</td>
							<td>{group.count}</td>
							<td><When at={group.first_seen} /></td>
							<td><When at={group.last_seen} /></td>
							<td class="app-code">{group.releases}</td>
						</tr>
					))}
				</Table>
			)}
		</section>
	);
}

export function ErrorGroupPage({ fingerprint }: { "fingerprint": string }) {
	const read = useGet(`/errors/${encodeURIComponent(fingerprint)}`) as { "data"?: { "error": Group; "occurrences": Occurrence[] }; "problem"?: string };

	if (read.problem !== undefined) {
		return <wa-callout variant="danger">{read.problem}</wa-callout>;
	}

	if (read.data === undefined) {
		return <wa-spinner />;
	}

	const { error, occurrences } = read.data;

	return (
		<section class="wa-stack wa-gap-l">
			<div><a href="#/errors">Errors</a></div>
			<h1 class="wa-heading-xl">{error.name}</h1>
			<p>{error.message}</p>
			<p class="wa-color-text-quiet">{error.source} · {error.route} · {error.count} in all, first <When at={error.first_seen} />, last <When at={error.last_seen} /> · releases {error.releases}</p>
			<Table head={["Id", "When", "Release", "Signed in as"]}>
				{occurrences.map((occurrence) => (
					<tr key={occurrence.id}>
						<td class="app-code"><a href={`#/errors/${occurrence.id}`}>{occurrence.id}</a></td>
						<td><When at={occurrence.at} /></td>
						<td class="app-code">{occurrence.release}</td>
						<td>{occurrence.user_id === null ? <span class="wa-color-text-quiet">signed out</span> : <a href={`#/users/${occurrence.user_id}`}>{occurrence.user_id.slice(0, 8)}…</a>}</td>
					</tr>
				))}
			</Table>
		</section>
	);
}

export function ErrorOccurrencePage({ id }: { "id": string }) {
	const read = useGet(`/errors/occurrence/${encodeURIComponent(id)}`) as { "data"?: { "occurrence": Occurrence }; "problem"?: string };

	if (read.problem !== undefined) {
		return (
			<section class="wa-stack wa-gap-l">
				<div><a href="#/errors">Errors</a></div>
				<wa-callout variant="danger">{read.problem}</wa-callout>
				<FindById />
			</section>
		);
	}

	if (read.data === undefined) {
		return <wa-spinner />;
	}

	const { occurrence } = read.data;

	return (
		<section class="wa-stack wa-gap-l">
			<div><a href="#/errors">Errors</a> · <a href={`#/errors/${occurrence.fingerprint}`}>its group ({occurrence.count})</a></div>
			<h1 class="wa-heading-xl">{occurrence.id}</h1>
			<p><strong>{occurrence.name}</strong> {occurrence.message}</p>
			<Table head={["When", "Where", "Release", "Signed in as", "Trace"]}>
				<tr>
					<td>{new Date(occurrence.at).toLocaleString()}</td>
					<td>{occurrence.source} · {occurrence.route}</td>
					<td class="app-code">{occurrence.release}</td>
					<td>{occurrence.user_id === null ? <span class="wa-color-text-quiet">signed out</span> : <a href={`#/users/${occurrence.user_id}`}>{occurrence.user_id.slice(0, 8)}…</a>}</td>
					<td class="app-code">{occurrence.trace_id ?? "—"}</td>
				</tr>
			</Table>
			{occurrence.breadcrumbs !== null && occurrence.breadcrumbs !== undefined && (
				<div class="wa-stack wa-gap-2xs">
					<h2 class="wa-heading-l">Just before</h2>
					<p class="wa-color-text-quiet">What the editor said happened last, oldest first (signed in, the sign-in's timeline has it all).</p>
					<div class="wa-cluster wa-gap-2xs">{occurrence.breadcrumbs.split(",").map((crumb, index) => <wa-badge key={index} variant="neutral" appearance="outlined">{crumb}</wa-badge>)}</div>
				</div>
			)}
			<h2 class="wa-heading-l">Stack</h2>
			{occurrence.stack === null || occurrence.stack === undefined ? <p class="wa-color-text-quiet">None recorded.</p>
				: occurrence.source === "editor" && occurrence.release !== null && /^[\da-f]{7,40}$/u.test(occurrence.release) ? <MappedStack text={occurrence.stack} release={occurrence.release} />
					: <Stack text={occurrence.stack} />}
		</section>
	);
}

/** Which Errors page a path is: the list, an occurrence (by its id), or a group (by its fingerprint). */
export function errorsPageFor(path: string) {
	const rest = decodeURIComponent(path.slice("/errors".length).replace(/^\//u, ""));

	return rest === "" ? <ErrorsPage /> : isErrorId(rest) ? <ErrorOccurrencePage id={rest} /> : <ErrorGroupPage fingerprint={rest} />;
}

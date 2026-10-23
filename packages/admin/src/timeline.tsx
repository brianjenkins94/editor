/**
 * A sign-in's page (packages/api/README.md, O5): who and how, and its timeline: every request
 * made through it, what the editor said happened (O6), its audit rows and its errors, in order, from GET /admin/sessions/:id/timeline. What a signed-in
 * person's session did, for looking into their problem: never a screen, code, keystrokes or file contents.
 * `sessions:replay`; reading it is audited, as every admin read is.
 */
import { useEffect, useState } from "preact/hooks";
import { get } from "./session";
import { Table, When } from "./views";
import { code } from "theme/recipes";

type Item =
	| { "kind": "request"; "at": number; "route": string; "status": number; "ms": number; "trace": string | null }
	| { "kind": "audit"; "at": number; "event": string; "reason": string | null; "detail": string | null; "trace": string | null }
	| { "kind": "error"; "at": number; "id": string; "name": string; "route": string | null; "message": string | null; "trace": string | null }
	| { "kind": "editor"; "at": number; "name": string; "detail": string | null; "trace"?: undefined };

interface Timeline {
	"session": { "id": string; "user_id": string; "client": string; "label": string | null; "method": string | null; "created_at": number; "last_used_at": number; "revoked_at": number | null };
	"items": Item[];
}

/** What a row of the timeline says, in the What and Detail columns. */
function describe(item: Item) {
	if (item.kind === "request") {
		return [<span key="what" class={code()}>{item.route}</span>, <span key="detail"><wa-badge variant={item.status >= 500 ? "danger" : item.status >= 400 ? "warning" : "success"}>{item.status}</wa-badge> {item.ms} ms</span>];
	}

	// What the editor said: a fixed vocabulary; a repo as the audit log's keyed tag, an error by its id.
	if (item.kind === "editor") {
		return [<span key="what" class="wa-cluster wa-gap-2xs"><wa-badge variant="brand" appearance="outlined">editor</wa-badge>{item.name}</span>, item.name === "error" && item.detail !== null ? <a key="detail" href={`#/errors/${item.detail}`}>{item.detail}</a> : <span key="detail" class={code() + " wa-color-text-quiet"}>{item.detail ?? ""}</span>];
	}

	if (item.kind === "audit") {
		return [<strong key="what">{item.event}</strong>, <span key="detail" class="wa-color-text-quiet">{[item.reason, item.detail].filter((part) => part !== null).join(" · ")}</span>];
	}

	return [<a key="what" href={`#/errors/${item.id}`}><strong>{item.name}</strong> {item.id}</a>, <span key="detail" class="wa-color-text-quiet">{item.route} {item.message}</span>];
}

export function TimelinePage({ id }: { "id": string }) {
	const [timeline, setTimeline] = useState<Timeline | undefined>();
	const [problem, setProblem] = useState<string | undefined>();
	const [only, setOnly] = useState<"all" | "editor" | "audit" | "error">("all");

	useEffect(() => {
		get<Timeline>(`/sessions/${encodeURIComponent(id)}/timeline`).then(setTimeline, (error: unknown) => {
			setProblem(error instanceof Error && / 404$/u.test(error.message) ? "No such sign-in." : error instanceof Error && / 403$/u.test(error.message) ? "Your roles don't include this." : "Couldn't load this.");
		});
	}, [id]);

	if (problem !== undefined) {
		return <wa-callout variant="danger">{problem}</wa-callout>;
	}

	if (timeline === undefined) {
		return <wa-spinner />;
	}

	const { session, items } = timeline;
	const shown = items.filter((item) => only === "all" || item.kind === only);

	return (
		<section class="wa-stack wa-gap-l">
			<div><a href="#/sessions">Sign-ins</a> · <a href={`#/users/${session.user_id}`}>its user</a></div>
			<h1 class="wa-heading-xl">Sign-in <span class={code()}>{session.id.slice(0, 8)}…</span></h1>
			<p class="wa-color-text-quiet">
				{session.client}, {session.label ?? "an unknown device"}, signed in by {session.method ?? "an unknown method"}; started <When at={session.created_at} />, last used <When at={session.last_used_at} />{session.revoked_at === null ? ", live" : <>, ended <When at={session.revoked_at} /></>}.
			</p>
			<div class="wa-split">
				<h2 class="wa-heading-l">Timeline</h2>
				<wa-select
					value={only}
					aria-label="Show"
					onChange={(event: Event) => {
						setOnly((event.target as HTMLSelectElement).value as typeof only);
					}}
				>
					<wa-option value="all">Everything ({items.length})</wa-option>
					<wa-option value="editor">The editor's events only</wa-option>
					<wa-option value="audit">Audit rows only</wa-option>
					<wa-option value="error">Errors only</wa-option>
				</wa-select>
			</div>
			<p class="wa-color-text-quiet">Each request through this sign-in (the last 30 days, at most 5,000), what the editor said happened (pages shown, repos loaded, commands run, panes opened, runs; never code, keystrokes or file contents), its audit rows and its errors, oldest first. A trace id finds the request in Cloudflare's logs (Workers → editor-api → Observability).</p>
			{shown.length === 0 ? <p class="wa-color-text-quiet">Nothing yet.</p> : (
				<Table head={["When", "What", "Detail", "Trace"]}>
					{shown.map((item, index) => {
						const [what, detail] = describe(item);

						return (
							<tr key={index}>
								<td title={new Date(item.at).toISOString()}>{new Date(item.at).toLocaleString()}</td>
								<td>{what}</td>
								<td>{detail}</td>
								<td class={code() + " wa-caption-s"}>{item.trace ?? ""}</td>
							</tr>
						);
					})}
				</Table>
			)}
		</section>
	);
}

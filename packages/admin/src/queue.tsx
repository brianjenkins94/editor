/**
 * The Queue page (packages/api/README.md, *The queue*): what was found that someone should look into — a new error
 * group, the week's review of agents' tool use — open until it's closed with what was done about it. `queue:read`;
 * closing one, `queue:close` (the owner's).
 */
import { useContext, useEffect, useState } from "preact/hooks";
import { get, submit } from "./session";
import { Permissions, Table, When } from "./ui";

interface Item { "id": number; "at": number; "kind": "error" | "agent-use"; "ref": string | null; "title": string; "detail": string | null; "closedAt": number | null; "closedBy": string | null; "outcome": string | null }

const KIND: Record<Item["kind"], string> = { "error": "New error", "agent-use": "Agents' tool use" };

function Lines({ text }: { "text": string | null }) {
	return text === null ? null : <span class="wa-color-text-quiet">{text.split("\n").flatMap((line, index) => (index === 0 ? [line] : [<br key={index} />, line]))}</span>;
}

/** One open item's close: what was done about it, said. */
function Close({ item, onClosed }: { "item": Item; "onClosed": () => void }) {
	const [outcome, setOutcome] = useState("");
	const [problem, setProblem] = useState<string | undefined>();

	return (
		<div class="wa-stack wa-gap-2xs">
			<div class="wa-cluster wa-gap-2xs">
				<wa-input size="small" placeholder="What was done about it" aria-label={`Outcome of ${item.title}`} value={outcome} onInput={(event: Event) => { setOutcome((event.target as HTMLInputElement).value); }} />
				<wa-button
					size="small"
					disabled={outcome.trim() === ""}
					onClick={() => {
						void submit(`/queue/${String(item.id)}/close`, { "outcome": outcome }).then(({ ok, body }) => {
							if (ok) {
								onClosed();
							} else {
								setProblem(body.reason ?? "Couldn't close it.");
							}
						});
					}}
				>
					Close
				</wa-button>
			</div>
			{problem !== undefined && <span class="wa-caption-s">{problem}</span>}
		</div>
	);
}

/** The open items, oldest first, or (the address's `?closed=1`) the latest closed, with what was done. */
export function QueuePage({ query }: { "query": URLSearchParams }) {
	const closed = query.get("closed") === "1";
	const canClose = useContext(Permissions).includes("queue:close");
	const [read, setRead] = useState<{ "items"?: Item[]; "problem"?: string }>({});
	const [again, setAgain] = useState(0);

	useEffect(() => {
		setRead({});
		get<{ "items": Item[] }>(`/queue${closed ? "?closed=1" : ""}`).then(({ items }) => {
			setRead({ "items": items });
		}, (error: unknown) => {
			setRead({ "problem": error instanceof Error && / 403$/u.test(error.message) ? "Your roles don't include this." : "Couldn't load the queue." });
		});
	}, [closed, again]);

	return (
		<section class="wa-stack wa-gap-l">
			<div class="wa-split">
				<h1 class="wa-heading-xl">Queue</h1>
				<wa-select
					value={closed ? "closed" : "open"}
					aria-label="Which"
					onChange={(event: Event) => {
						location.hash = (event.target as HTMLSelectElement).value === "closed" ? "#/queue?closed=1" : "#/queue";
					}}
				>
					<wa-option value="open">Open</wa-option>
					<wa-option value="closed">Closed</wa-option>
				</wa-select>
			</div>
			<p class="wa-color-text-quiet">What was found that someone should look into, so it isn't left unnoticed: each new error group as it's first seen, and every week a review of agents' tool use. Each stays open until it's closed with what was done about it. Asked to address the queue, an agent works through these (packages/api, `npm run queue`).</p>
			{read.problem !== undefined && <wa-callout variant="danger">{read.problem}</wa-callout>}
			{read.items === undefined ? read.problem === undefined && <wa-spinner /> : read.items.length === 0 ? <p class="wa-color-text-quiet">{closed ? "None closed yet." : "Nothing open. 🎉"}</p> : (
				<Table head={closed ? ["Opened", "What", "Item", "Closed", "Outcome"] : ["Opened", "What", "Item", ...canClose ? ["Close"] : []]}>
					{read.items.map((item) => (
						<tr key={item.id}>
							<td><When at={item.at} /></td>
							<td><wa-badge appearance="outlined" variant={item.kind === "error" ? "danger" : "brand"}>{KIND[item.kind]}</wa-badge></td>
							<td>
								<div class="wa-stack wa-gap-3xs">
									{item.kind === "error" && item.ref !== null ? <a href={`#/errors/${item.ref}`}><strong>{item.title}</strong></a> : <strong>{item.title}</strong>}
									<Lines text={item.detail} />
								</div>
							</td>
							{closed
								? (
										<>
											<td>{item.closedAt === null ? null : <When at={item.closedAt} />}</td>
											<td>{item.outcome}</td>
										</>
									)
								: canClose ? <td><Close item={item} onClosed={() => { setAgain((count) => count + 1); }} /></td> : null}
						</tr>
					))}
				</Table>
			)}
		</section>
	);
}

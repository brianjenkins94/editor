/** @jsxImportSource preact */
/**
 * A preview's question, in its window: the app wants to reach something the policy hasn't decided, and the window says so
 * until it's answered, where someone's looking at the app (RUNNING.md, *Rules*). There's no list of these to go and look at.
 */
import { render } from "preact";
import { previewAsks } from "theme/styles/shell";
import "theme/components/button";
import "theme/components/callout";

export type PreviewAnswer = "allow" | "allow-always" | "deny" | "deny-always";

/** What's asked: what the call is, and what it reaches. */
export interface PreviewAsk { "port": number; "capability": string; "resource": string }

const WHAT: Record<string, string> = { "net": "reach", "net.ws": "open a WebSocket to", "net.webrtc": "open a peer connection" };

interface Waiting { "ask": PreviewAsk; "answer": (answer: PreviewAnswer) => void }

/** Each window's questions. */
const waitingIn = new WeakMap<HTMLElement, Waiting[]>();

function draw(element: HTMLElement, holder: HTMLElement): void {
	const waiting = waitingIn.get(element) ?? [];
	const button = (each: Waiting, label: string, answer: PreviewAnswer, title: string): preact.JSX.Element => (
		<wa-button
			appearance={answer.startsWith("allow") ? "filled" : "plain"}
			size="small"
			title={title}
			onClick={() => {
				waitingIn.set(element, (waitingIn.get(element) ?? []).filter((other) => other !== each));
				draw(element, holder);
				each.answer(answer);
			}}
		>
			{label}
		</wa-button>
	);

	render(
		<>
			{waiting.map((each) => (
				<wa-callout key={each.ask.capability + each.ask.resource} variant="warning" size="small">
					<div class="wa-stack wa-gap-xs">
						<span>{`This app wants to ${WHAT[each.ask.capability] ?? each.ask.capability}${each.ask.resource === "" ? "" : ` ${each.ask.resource}`}.`}</span>
						<div class="wa-cluster wa-gap-2xs">
							{button(each, "Allow", "allow", "Until this server stops")}
							{button(each, "Always allow", "allow-always", "A rule in your policy, for this and the rest of its site")}
							{button(each, "Deny", "deny", "Until this server stops")}
							{button(each, "Always deny", "deny-always", "A rule in your policy, for this and the rest of its site")}
						</div>
					</div>
				</wa-callout>
			))}
		</>,
		holder
	);
}

/** Ask in `element`, the window, until it's answered. */
export async function askInWindow(element: HTMLElement, ask: PreviewAsk): Promise<PreviewAnswer> {
	let holder = element.querySelector<HTMLElement>(":scope > [data-preview-asks]");

	if (holder === null) {
		holder = document.createElement("div");
		holder.dataset["previewAsks"] = "";
		holder.className = `${previewAsks()} wa-stack wa-gap-2xs`;
		element.append(holder);
	}

	const shown = holder;

	return new Promise((resolve) => {
		waitingIn.set(element, [...waitingIn.get(element) ?? [], { "ask": ask, "answer": resolve }]);
		draw(element, shown);
	});
}

/**
 * The sign-ins that surprised the behavior model most (packages/api/README.md, B8, "Behavior"): mean surprise a step, what
 * they did that the editor doesn't, and their most surprising steps, as templates. A high score is a reason to look, not
 * a verdict.
 */
import type { Columns } from "./sessions";
import type { Session } from "./ui";
import { SessionRows } from "./sessions";
import { Loading, useRead } from "./ui";

/** A sign-in as /admin/unusual answers it: its score, and what it did that the editor doesn't. */
export interface Unusual extends Session {
	"score": { "mean": number; "steps": number; "top": { "from": string; "to": string; "gap": number; "bits": number }[]; "updatedAt": number };
	"flags": Record<string, number>;
}

/** The gap buckets the model counts by (packages/api/src/behavior.ts, gapOf). */
const GAPS = ["at once", "within 1 s", "within 10 s", "later"];

/** Strip the proxy's prefix: the transitions read as the calls they are. */
const call = (action: string): string => action.replace(" /github/api/", " ").replace(" /github/git/", " git ");

export function UnusualPage() {
	const read = useRead("/unusual");
	const columns: Columns<Unusual> = {
		"head": ["Surprise", "Flags", "Most surprising steps"],
		"cells": (session) => [
			<td key="score" title={`${session.score.steps} steps scored`}><wa-badge variant={session.score.mean >= 6 ? "danger" : session.score.mean >= 4 ? "warning" : "neutral"}>{session.score.mean.toFixed(1)} bits</wa-badge> <span class="wa-color-text-quiet">{session.score.steps}</span></td>,
			<td key="flags"><div class="wa-cluster wa-gap-2xs">{Object.entries(session.flags).map(([event, count]) => <wa-badge key={event} variant="warning" appearance="outlined">{event} {count}</wa-badge>)}</div></td>,
			<td key="top">
				{session.score.top.map((step) => <div key={`${step.from}${step.to}${step.gap}`} class="mono">{call(step.from)} → {call(step.to)} <span class="wa-color-text-quiet">{GAPS[step.gap]}, {step.bits} bits</span></div>)}
			</td>
		]
	};

	return (
		<section class="wa-stack wa-gap-l">
			<h1 class="wa-heading-xl">Unusual sign-ins</h1>
			<p class="wa-color-text-quiet">Each sign-in's steps, scored against what sign-ins usually do next (packages/api/README.md, "Behavior"): the mean surprise a step, in bits, highest first. Steps and calls are templates; no values, repositories or contents.</p>
			<Loading read={read}>{() => (read.data!.sessions.length === 0 ? <p class="wa-color-text-quiet">Nothing scored yet: sign-ins are scored an hour after they're used.</p> : <SessionRows sessions={read.data!.sessions} withUser={true} columns={columns} />)}</Loading>
		</section>
	);
}

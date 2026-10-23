/**
 * The kill switch (packages/api/README.md, O1): while it's on, a banner says why, by whom and since
 * when, on every page; the owner (`maintenance:switch`) turns it off there, or on from the Overview, with a reason. The
 * API audits every flip and emails the owner. Beside it, the narrower switches (O8): one part of the API paused, each
 * shown on every page while it is, paused or resumed by the owner from the Overview.
 */
import { useState } from "preact/hooks";
import { submit } from "./session";

export interface Maintenance { "on": boolean; "reason": string | null; "by": string | null; "at": number | null }

/** Flip it, then draw the app again from /me. What went wrong, if it didn't. */
async function flip(turn: "on" | "off", reason: string): Promise<string | undefined> {
	try {
		const answer = await submit<Maintenance>("/maintenance", { "turn": turn, "reason": reason });

		if (answer.ok) {
			location.reload();

			return undefined;
		}

		return answer.body.reason ?? "That didn't work. Try again.";
	} catch {
		return "Couldn't reach the API.";
	}
}

/** A narrower switch (packages/api src/maintenance.ts, SWITCHES): what it pauses, in words, and whether it is. */
export interface SwitchState { "name": string; "what": string; "detail": string; "paused": { "reason": string | null; "by": string | null; "at": number } | null }

/** Pause or resume one, then draw the app again from /me. What went wrong, if it didn't. */
async function turnSwitch(name: string, turn: "pause" | "resume", reason: string): Promise<string | undefined> {
	try {
		const answer = await submit<unknown>("/switches", { "name": name, "turn": turn, "reason": reason });

		if (answer.ok) {
			location.reload();

			return undefined;
		}

		return answer.body.reason ?? "That didn't work. Try again.";
	} catch {
		return "Couldn't reach the API.";
	}
}

/** Who flipped it, in words. */
const who = (by: string | null): string => (by === null ? "someone" : by.startsWith("user:") ? "the owner" : by);

export function MaintenanceBanner({ maintenance, canSwitch }: { "maintenance": Maintenance; "canSwitch": boolean }) {
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | undefined>();

	if (!maintenance.on) {
		return null;
	}

	return (
		<wa-callout variant="danger">
			<div class="wa-split">
				<span>
					<strong>The API is down for maintenance.</strong> {maintenance.reason ?? "No reason given"}; turned on by {who(maintenance.by)}{maintenance.at === null ? "" : `, ${new Date(maintenance.at).toLocaleString()}`}. Everyone but you gets "Down for maintenance".
					{problem !== undefined && <> {problem}</>}
				</span>
				{canSwitch && (
					<wa-button
						size="small"
						loading={busy}
						onClick={() => {
							setBusy(true);
							void flip("off", "").then((failed) => {
								setBusy(false);
								setProblem(failed);
							});
						}}
					>
						Turn it off
					</wa-button>
				)}
			</div>
		</wa-callout>
	);
}

/** On the Overview, for the owner: turning it on, with a reason, after a second look. */
export function KillSwitch({ maintenance }: { "maintenance": Maintenance }) {
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | undefined>();

	if (maintenance.on) {
		return null;
	}

	return (
		<wa-card>
			<div class="wa-stack">
				<h2 class="wa-heading-m">Kill switch</h2>
				<p class="wa-color-text-quiet">Takes the API down for everyone but you: the editor carries on signed out, the sites stay up. Every flip is audited and emailed to you.</p>
				{problem !== undefined && <wa-callout variant="danger">{problem}</wa-callout>}
				{confirming
					? (
						<form
							class="wa-cluster wa-gap-s wa-align-items-end"
							onSubmit={(event) => {
								event.preventDefault();
								setBusy(true);
								void flip("on", (event.currentTarget.elements.namedItem("reason") as HTMLInputElement).value).then((failed) => {
									setBusy(false);
									setProblem(failed);
								});
							}}
						>
							<wa-input name="reason" label="Why" placeholder="What's wrong" required />
							<wa-button type="submit" variant="danger" loading={busy}>Take the API down</wa-button>
							<wa-button appearance="plain" onClick={() => setConfirming(false)}>Cancel</wa-button>
						</form>
					)
					: <div><wa-button variant="danger" appearance="outlined" onClick={() => setConfirming(true)}>Turn on…</wa-button></div>}
			</div>
		</wa-card>
	);
}

/** On every page: each paused switch, why, by whom and since when; the owner resumes it there. */
export function PausedBanner({ switches, canSwitch }: { "switches": SwitchState[]; "canSwitch": boolean }) {
	const [busy, setBusy] = useState<string | undefined>();
	const [problem, setProblem] = useState<string | undefined>();

	return (
		<>
			{switches.filter((each) => each.paused !== null).map((each) => (
				<wa-callout key={each.name} variant="warning">
					<div class="wa-split">
						<span>
							<strong>Paused: {each.what}.</strong> {each.paused?.reason ?? "No reason given"}; by {who(each.paused?.by ?? null)}, {new Date(each.paused?.at ?? 0).toLocaleString()}. {each.detail}
							{problem !== undefined && <> {problem}</>}
						</span>
						{canSwitch && (
							<wa-button
								size="small"
								loading={busy === each.name}
								onClick={() => {
									setBusy(each.name);
									void turnSwitch(each.name, "resume", "").then((failed) => {
										setBusy(undefined);
										setProblem(failed);
									});
								}}
							>
								Resume
							</wa-button>
						)}
					</div>
				</wa-callout>
			))}
		</>
	);
}

/** One switch on the Overview: what it pauses, and pausing it with a reason after a second look. */
function SwitchRow({ state }: { "state": SwitchState }) {
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | undefined>();

	return (
		<div class="wa-stack wa-gap-xs">
			<div class="wa-split">
				<div class="wa-stack wa-gap-3xs">
					<strong>{state.what}</strong>
					<span class="wa-caption-m wa-color-text-quiet">{state.detail}</span>
				</div>
				{state.paused !== null
					? <wa-badge variant="warning">paused</wa-badge>
					: !confirming && <wa-button size="small" appearance="outlined" onClick={() => setConfirming(true)}>Pause…</wa-button>}
			</div>
			{problem !== undefined && <wa-callout variant="danger">{problem}</wa-callout>}
			{confirming && state.paused === null && (
				<form
					class="wa-cluster wa-gap-s wa-align-items-end"
					onSubmit={(event) => {
						event.preventDefault();
						setBusy(true);
						void turnSwitch(state.name, "pause", (event.currentTarget.elements.namedItem("reason") as HTMLInputElement).value).then((failed) => {
							setBusy(false);
							setProblem(failed);
						});
					}}
				>
					<wa-input name="reason" label="Why" placeholder="What's wrong" required />
					<wa-button type="submit" variant="warning" loading={busy}>Pause it</wa-button>
					<wa-button appearance="plain" onClick={() => setConfirming(false)}>Cancel</wa-button>
				</form>
			)}
		</div>
	);
}

/** On the Overview, for the owner: the narrower switches, each paused or resumed on its own. A paused one is resumed
 *  from its banner. */
export function Switches({ switches }: { "switches": SwitchState[] }) {
	return (
		<wa-card>
			<div class="wa-stack">
				<h2 class="wa-heading-m">Switches</h2>
				<p class="wa-color-text-quiet">One part of the API paused, not all of it: the rest carries on. Every flip is audited and emailed to you.</p>
				{switches.map((state, index) => (
					<div key={state.name} class="wa-stack">
						{index > 0 && <wa-divider />}
						<SwitchRow state={state} />
					</div>
				))}
			</div>
		</wa-card>
	);
}

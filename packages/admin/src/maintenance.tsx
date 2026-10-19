/**
 * The kill switch (packages/api/OPERATIONS.md, "The kill switch"): while it's on, a banner says why, by whom and since
 * when, on every page; the owner (`maintenance:switch`) turns it off there, or on from the Overview, with a reason. The
 * API audits every flip and emails the owner.
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

/** Who flipped it, in words. */
const who = (by: string | null): string => (by === null ? "someone" : by.startsWith("user:") ? "the owner" : by);

export function MaintenanceBanner({ maintenance, canSwitch }: { "maintenance": Maintenance; "canSwitch": boolean }) {
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | undefined>();

	if (!maintenance.on) {
		return null;
	}

	return (
		<wa-callout variant="danger" class="maintenance">
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
							class="wa-cluster wa-gap-s maintenance-form"
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

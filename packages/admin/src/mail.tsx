/**
 * The Mail page (README.md): what our email did, from GET /admin/mail. Ours (the audit log: codes sent, sign-ins by
 * email, refusals on the way) beside Cloudflare's (Email Service's analytics: delivered or not, and SPF, DKIM and DMARC).
 * Counts by day and reason; never an address.
 */
import { useEffect, useState } from "preact/hooks";
import { get } from "./session";
import { Table } from "./views";

interface Mail {
	"window": { "days": number; "since": string; "until": string };
	"days": { "day": string; "sent": number; "delivered": number; "failed": number; "signedIn": number; "refused": number }[];
	"refusals": { "reason": string; "count": number }[];
	"failures": { "reason": string; "count": number }[];
	"authentication": { "check": string; "results": { "result": string; "count": number }[] }[];
	"cloudflare": { "ok": true } | { "error": string };
}

const WINDOWS = [7, 14, 30];

export function MailPage({ query }: { "query": URLSearchParams }) {
	const days = query.get("days") ?? "14";
	const [mail, setMail] = useState<Mail | undefined>();
	const [problem, setProblem] = useState<string | undefined>();

	useEffect(() => {
		setMail(undefined);
		get<Mail>(`/mail?days=${encodeURIComponent(days)}`).then(setMail, (error: unknown) => {
			setProblem(error instanceof Error && / 403$/u.test(error.message) ? "Your roles don't include this." : "Couldn't load this.");
		});
	}, [days]);

	if (problem !== undefined) {
		return <wa-callout variant="danger">{problem}</wa-callout>;
	}

	if (mail === undefined) {
		return <wa-spinner />;
	}

	const total = (key: "sent" | "delivered" | "failed" | "signedIn"): number => mail.days.reduce((sum, day) => sum + day[key], 0);
	const card = (label: string, value: number | string) => (
		<wa-card>
			<div class="wa-stack wa-gap-2xs">
				<span class="wa-caption-m">{label}</span>
				<strong class="wa-heading-2xl">{value}</strong>
			</div>
		</wa-card>
	);
	const cloudflare = "error" in mail.cloudflare ? undefined : true;

	return (
		<section class="wa-stack wa-gap-l">
			<div class="wa-split">
				<h1 class="wa-heading-xl">Mail</h1>
				<wa-select
					value={days}
					aria-label="Window"
					onChange={(event: Event) => {
						location.hash = `#/mail?days=${(event.target as HTMLSelectElement).value}`;
					}}
				>
					{WINDOWS.map((window) => <wa-option key={window} value={String(window)}>{`Last ${window} days`}</wa-option>)}
				</wa-select>
			</div>
			<p class="muted">Sign-in codes we sent and what came of them: our audit log beside Cloudflare's delivery records. Counts only; never an address.</p>
			{"error" in mail.cloudflare && <wa-callout variant="neutral">Cloudflare's delivery records aren't here: {mail.cloudflare.error}</wa-callout>}
			<div class="wa-grid wa-gap-l stats">
				{card("Codes sent", total("sent"))}
				{card("Delivered", cloudflare === undefined ? "—" : total("delivered"))}
				{card("Not delivered", cloudflare === undefined ? "—" : total("failed"))}
				{card("Signed in by email", total("signedIn"))}
			</div>
			<h2 class="wa-heading-l">By day</h2>
			<Table head={["Day", "Sent", "Delivered", "Not delivered", "Signed in", "Refused"]}>
				{mail.days.toReversed().map((day) => (
					<tr key={day.day}>
						<td>{day.day}</td>
						<td>{day.sent}</td>
						<td>{cloudflare === undefined ? "—" : day.delivered}</td>
						<td>{cloudflare === undefined ? "—" : day.failed}</td>
						<td>{day.signedIn}</td>
						<td>{day.refused}</td>
					</tr>
				))}
			</Table>
			<div class="wa-grid wa-gap-l pair">
				<div class="wa-stack">
					<h2 class="wa-heading-l">Refused, by reason</h2>
					{mail.refusals.length === 0 ? <p class="muted">None.</p> : (
						<Table head={["Reason", "Times"]}>
							{mail.refusals.map((row) => <tr key={row.reason}><td>{row.reason}</td><td>{row.count}</td></tr>)}
						</Table>
					)}
				</div>
				<div class="wa-stack">
					<h2 class="wa-heading-l">Not delivered, by reason</h2>
					{mail.failures.length === 0 ? <p class="muted">None.</p> : (
						<Table head={["Status and cause", "Emails"]}>
							{mail.failures.map((row) => <tr key={row.reason}><td>{row.reason}</td><td>{row.count}</td></tr>)}
						</Table>
					)}
				</div>
			</div>
			{cloudflare !== undefined && (
				<div class="wa-stack">
					<h2 class="wa-heading-l">Authentication</h2>
					<Table head={["Check", "Results"]}>
						{mail.authentication.map((check) => (
							<tr key={check.check}>
								<td>{check.check.toUpperCase()}</td>
								<td><div class="wa-cluster wa-gap-2xs">{check.results.length === 0 ? <span class="muted">nothing sent yet</span> : check.results.map((result) => <wa-badge key={result.result} variant={result.result === "pass" ? "success" : "warning"}>{result.result} {result.count}</wa-badge>)}</div></td>
							</tr>
						))}
					</Table>
				</div>
			)}
		</section>
	);
}

/**
 * The Mail page (README.md): what our email did, from GET /admin/mail. Ours (the audit log: codes sent, sign-ins by
 * email, refusals on the way) beside Cloudflare's (Email Service's analytics: delivered or not, and SPF, DKIM and DMARC).
 * Counts by day and reason; never a user's address. And the smoke test (its last runs, and a run now), our own inbox
 * (GET /admin/inbox: mail to our own addresses, who from and its subject), and the alerts emailed to the owner (GET
 * /admin/alerts: each, and whether Cloudflare delivered it; and a test alert).
 */
import { useContext, useEffect, useState } from "preact/hooks";
import { get, post } from "./session";
import { Permissions, Table } from "./views";

interface Mail {
	"window": { "days": number; "since": string; "until": string };
	"days": { "day": string; "sent": number; "delivered": number; "failed": number; "signedIn": number; "refused": number }[];
	"refusals": { "reason": string; "count": number }[];
	"failures": { "reason": string; "count": number }[];
	"authentication": { "check": string; "results": { "result": string; "count": number }[] }[];
	"smoke": { "at": number; "passed": boolean; "reason": string }[];
	"cloudflare": { "ok": true } | { "error": string };
}

interface Alerts {
	"configured": boolean;
	"delivery": string | null;
	"alerts": { "id": number; "at": number; "subject": string; "text": string; "status": string; "detail": string | null }[];
}

/** How an alert's fate reads. */
const variantOf = (status: string): string => (status === "delivered" ? "success" : status === "sent" ? "neutral" : "danger");

/** The emails to the owner (the kill switch, the cost guard, the tripwire, errors): each, what it said, and what
 *  Cloudflare says became of it; and a test alert, to check they arrive without anyone asking. */
function AlertsSection() {
	const canSend = useContext(Permissions).includes("mail:test");
	const [alerts, setAlerts] = useState<Alerts | undefined>();
	const [sending, setSending] = useState(false);
	const [reads, setReads] = useState(0);
	const [open, setOpen] = useState<number | undefined>();

	useEffect(() => {
		get<Alerts>("/alerts").then(setAlerts, () => undefined);
	}, [reads]);

	return (
		<div class="wa-stack">
			<div class="wa-split">
				<h2 class="wa-heading-l">Alerts to you</h2>
				{canSend && (
					<wa-button
						size="small"
						loading={sending}
						onClick={() => {
							setSending(true);
							post("/alerts/test", {}).finally(() => {
								setSending(false);
								setReads(reads + 1);
								// Cloudflare's delivery record lags a minute or so: look again then.
								setTimeout(() => {
									setReads((count) => count + 1);
								}, 90_000);
							});
						}}
					>
						Send a test alert
					</wa-button>
				)}
			</div>
			<p class="wa-color-text-quiet">Every email to ALERT_EMAIL: the kill switch flipping, spend past its budget, the tripwire, errors. "Sent" means Email Service took it and Cloudflare hasn't reported on it yet (a minute or two).</p>
			{alerts !== undefined && !alerts.configured && <wa-callout variant="danger">ALERT_EMAIL isn't set in this environment: alerts are logged here but not sent.</wa-callout>}
			{alerts?.delivery !== null && alerts?.delivery !== undefined && <wa-callout variant="neutral">{alerts.delivery}</wa-callout>}
			{alerts === undefined ? <wa-spinner /> : alerts.alerts.length === 0 ? <p class="wa-color-text-quiet">None yet.</p> : (
				<Table head={["When", "Alert", "Delivery"]}>
					{alerts.alerts.map((alert) => (
						<tr key={alert.id}>
							<td>{new Date(alert.at).toLocaleString()}</td>
							<td>
								<a
									href="#/mail"
									onClick={(event) => {
										event.preventDefault();
										setOpen(open === alert.id ? undefined : alert.id);
									}}
								>
									{alert.subject}
								</a>
								{open === alert.id && <div class="wa-stack wa-gap-3xs wa-caption-m">{alert.text.split("\n").map((line, index) => <span key={index}>{line}</span>)}</div>}
							</td>
							<td><wa-badge variant={variantOf(alert.status)}>{alert.status}</wa-badge>{alert.detail === null ? "" : ` ${alert.detail}`}</td>
						</tr>
					))}
				</Table>
			)}
		</div>
	);
}

interface Inbox { "addresses": string[]; "mail": { "id": number; "at": number; "address": string; "sender": string; "subject": string; "size": number }[] }

/** The smoke test's last runs, and a run now (it sends a real email: `mail:test`). */
function Smoke({ runs, onRan }: { "runs": Mail["smoke"]; "onRan": () => void }) {
	const canRun = useContext(Permissions).includes("mail:test");
	const [running, setRunning] = useState(false);
	const [result, setResult] = useState<string | undefined>();

	return (
		<div class="wa-stack">
			<div class="wa-split">
				<h2 class="wa-heading-l">Smoke test</h2>
				{canRun && (
					<wa-button
						size="small"
						loading={running}
						onClick={() => {
							setRunning(true);
							setResult(undefined);
							post<{ "ok": boolean; "seconds"?: number; "step"?: string; "reason"?: string }>("/mail/smoke", {}).then((answer) => {
								setResult(answer.ok ? `Passed: the email came back in ${answer.seconds} s.` : `Failed at ${answer.step}: ${answer.reason}`);
							}, () => {
								setResult("Couldn't run it.");
							}).finally(() => {
								setRunning(false);
								onRan();
							});
						}}
					>
						Run now
					</wa-button>
				)}
			</div>
			<p class="wa-color-text-quiet">Daily, and on demand: a sign-in by email with our own address, the code sent through Email Service and read back from our inbox through Email Routing, then the sign-in ended.</p>
			{result !== undefined && <wa-callout variant={result.startsWith("Passed") ? "success" : "danger"}>{result}</wa-callout>}
			{runs.length === 0 ? <p class="wa-color-text-quiet">No runs yet.</p> : (
				<Table head={["When", "Result", "Detail"]}>
					{runs.map((run) => (
						<tr key={run.at}>
							<td>{new Date(run.at).toLocaleString()}</td>
							<td><wa-badge variant={run.passed ? "success" : "danger"}>{run.passed ? "passed" : "failed"}</wa-badge></td>
							<td>{run.reason}</td>
						</tr>
					))}
				</Table>
			)}
		</div>
	);
}

/** Our own inbox: mail to our own addresses, kept a day. */
function InboxSection({ inbox }: { "inbox": Inbox | undefined }) {
	return (
		<div class="wa-stack">
			<h2 class="wa-heading-l">Inbox</h2>
			<p class="wa-color-text-quiet">Mail to our own addresses ({inbox?.addresses.join(", ") ?? "…"}), routed here by Email Routing: who from, its subject and size, kept a day. Never its body.</p>
			{inbox === undefined || inbox.mail.length === 0 ? <p class="wa-color-text-quiet">Nothing in the last day.</p> : (
				<Table head={["When", "To", "From", "Subject", "Size"]}>
					{inbox.mail.map((mail) => (
						<tr key={mail.id}>
							<td>{new Date(mail.at).toLocaleString()}</td>
							<td class="mono">{mail.address}</td>
							<td class="mono">{mail.sender}</td>
							<td>{mail.subject}</td>
							<td>{`${Math.ceil(mail.size / 1024)} KB`}</td>
						</tr>
					))}
				</Table>
			)}
		</div>
	);
}

const WINDOWS = [7, 14, 30];

export function MailPage({ query }: { "query": URLSearchParams }) {
	const days = query.get("days") ?? "14";
	const [mail, setMail] = useState<Mail | undefined>();
	const [inbox, setInbox] = useState<Inbox | undefined>();
	const [problem, setProblem] = useState<string | undefined>();
	const [reads, setReads] = useState(0);

	useEffect(() => {
		get<Mail>(`/mail?days=${encodeURIComponent(days)}`).then(setMail, (error: unknown) => {
			setProblem(error instanceof Error && / 403$/u.test(error.message) ? "Your roles don't include this." : "Couldn't load this.");
		});
		get<Inbox>("/inbox").then(setInbox, () => undefined);
	}, [days, reads]);

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
			<p class="wa-color-text-quiet">Sign-in codes we sent and what came of them: our audit log beside Cloudflare's delivery records. Counts only; never an address.</p>
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
					{mail.refusals.length === 0 ? <p class="wa-color-text-quiet">None.</p> : (
						<Table head={["Reason", "Times"]}>
							{mail.refusals.map((row) => <tr key={row.reason}><td>{row.reason}</td><td>{row.count}</td></tr>)}
						</Table>
					)}
				</div>
				<div class="wa-stack">
					<h2 class="wa-heading-l">Not delivered, by reason</h2>
					{mail.failures.length === 0 ? <p class="wa-color-text-quiet">None.</p> : (
						<Table head={["Status and cause", "Emails"]}>
							{mail.failures.map((row) => <tr key={row.reason}><td>{row.reason}</td><td>{row.count}</td></tr>)}
						</Table>
					)}
				</div>
			</div>
			<Smoke
				runs={mail.smoke}
				onRan={() => {
					setReads(reads + 1);
				}}
			/>
			<AlertsSection />
			<InboxSection inbox={inbox} />
			{cloudflare !== undefined && (
				<div class="wa-stack">
					<h2 class="wa-heading-l">Authentication</h2>
					<Table head={["Check", "Results"]}>
						{mail.authentication.map((check) => (
							<tr key={check.check}>
								<td>{check.check.toUpperCase()}</td>
								<td><div class="wa-cluster wa-gap-2xs">{check.results.length === 0 ? <span class="wa-color-text-quiet">nothing sent yet</span> : check.results.map((result) => <wa-badge key={result.result} variant={result.result === "pass" ? "success" : "warning"}>{result.result} {result.count}</wa-badge>)}</div></td>
							</tr>
						))}
					</Table>
				</div>
			)}
		</section>
	);
}

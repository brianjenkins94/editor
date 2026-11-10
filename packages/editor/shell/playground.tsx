/** @jsxImportSource preact */
/**
 * TypeScript Playground links (shared/playground-link.ts), both ways. Swap the host of a playground link for the editor's
 * and it opens here as a real workspace: an editor of its own (an instance, shared/instance.ts, named by the link), so
 * following a link never replaces the workspace you're in, and reloading it keeps what you've changed since. And the top
 * bar's Share writes your workspace as a Playground v2 link, which opens here or in the TypeScript Playground.
 */
import type { SharedWorkspace } from "../shared/playground-link";
import type { ShellContext, ShellFeature } from "./feature";
import { logger } from "@brianjenkins94/util/logger";
import { Share2 } from "lucide";
import { useState } from "preact/hooks";
import { ghError, ghOk, popoverBody } from "theme/styles/shell";
import { instance } from "../shared/instance";
import { parsePlaygroundLink, playgroundLink } from "../shared/playground-link";
import { site } from "./address";
import { errText } from "./feature";
import { Icon } from "./icon";

const log = logger({ "source": "shell" });

/** The instance a link opens in: named by what it holds, so the same link opens the same editor. */
async function instanceOf(hash: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(hash)));

	return `playground-${[
		...digest.slice(0, 6)
	].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** A link's query string as the playground wrote it: the instance's name isn't one of its compiler options. */
function linkQuery(): string {
	const query = new URLSearchParams(location.search);

	query.delete("instance");

	return query.toString();
}

/** A playground link in the address: opened in its own instance, its files the workspace there once the app listens. */
async function fromAddress(shell: ShellContext): Promise<void> {
	const project = parsePlaygroundLink(location.hash, linkQuery());

	if (project === undefined) {
		return;
	}

	if (instance === undefined) {
		const own = new URL(location.href);

		own.searchParams.set("instance", await instanceOf(location.hash));
		location.replace(own.href);

		return;
	}

	// (opened once: a reload keeps what was changed since instead of opening the link again)
	history.replaceState(history.state, "", location.pathname + location.search);

	await log.span("editor.shell.playground.open", { "count": project.files.length }, async () => {
		// (asked as the workbench answers: by then the app, which takes a project's files, listens too)
		await shell.rpc.request("git.origin", undefined, { "timeoutMs": 10_000, "waitForResponderMs": 120_000 });
		shell.hub.publish("project.openFiles", project);
	});
}

/** What Share made: the link, what it left out, and whether it's on the clipboard. */
interface Shared { "url": string; "skipped": string[]; "copied": boolean }

function ShareControl({ shell }: { "shell": ShellContext }) {
	const [open, setOpen] = useState(false);
	const [shared, setShared] = useState<Shared | { "error": string } | undefined>(undefined);

	const share = async (): Promise<void> => {
		setOpen(true);
		setShared(undefined);

		try {
			const made = await log.span("editor.shell.playground.share", {}, async (span) => {
				const workspace = await shell.rpc.request("workbench.files", undefined, { "timeoutMs": 20_000 }) as SharedWorkspace;
				const link = playgroundLink(site(), workspace);

				span.end({ "count": workspace.files.length, "bytes": link.url.length });

				return link;
			});

			setShared({ ...made, "copied": await navigator.clipboard.writeText(made.url).then(() => true, () => false) });
		} catch (error) {
			setShared({
				"error": errText(error)
			});
		}
	};

	const body = () => {
		if (shared === undefined) {
			return <span class="wa-caption-2xs">Making a link…</span>;
		}

		if ("error" in shared) {
			return <span class={"wa-caption-2xs " + ghError()}>{shared.error}</span>;
		}

		const kb = (shared.url.length / 1024).toFixed(1);
		const skipped = shared.skipped.length === 0
			? ""
			: ` · ${String(shared.skipped.length)} binary ${shared.skipped.length === 1
				? "file"
				: "files"} left out`;

		return (
			<>
				<span class={"wa-caption-2xs " + (shared.copied
					? ghOk()
					: "wa-color-text-quiet")}
				>
					{`${shared.copied ? "Link copied." : "Copy this link."} It opens this project here, or in the TypeScript Playground.`}
				</span>

				<wa-input size="small" readonly value={shared.url} aria-label="Share link" />

				<span class="wa-caption-2xs">
					{`${kb} KB${shared.url.length > 8192
						? ", which some apps cut"
						: ""}${skipped}`}
				</span>
			</>
		);
	};

	return (
		<>
			<wa-button id="shell-share" appearance="plain" size="small" title="Share as a link" aria-label="Share"><Icon node={Share2} /></wa-button>

			<wa-popover
				for="shell-share"
				placement="bottom-start"
				open={open}
				onwa-show={(event: Event) => {
					if (event.target === event.currentTarget) {
						void share();
					}
				}}
				onwa-hide={(event: Event) => {
					if (event.target === event.currentTarget) {
						setOpen(false);
					}
				}}
			>
				<div class={"wa-stack wa-gap-xs " + popoverBody()} role="group" aria-label="Share">
					<span class="wa-font-weight-semibold wa-font-size-s">Share</span>

					{body()}
				</div>
			</wa-popover>
		</>
	);
}

export const playground: ShellFeature = {
	"start": (shell) => {
		void fromAddress(shell).catch((error: unknown) => {
			log.warn("the playground link couldn't be opened", {
				"error": errText(error)
			});
		});
	},
	"control": { "place": "start", "Control": ShareControl }
};

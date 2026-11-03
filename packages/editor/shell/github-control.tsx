/** @jsxImportSource preact */
/**
 * The top bar's GitHub button and its popover: signing in (sign-in.tsx), then a repository to load (repo-load.tsx).
 */
import type { ShellFeature } from "./feature";
import { GitBranch } from "lucide";
import { popoverBody } from "theme/styles/shell";
import { shared, useStore } from "./feature";
import { Icon } from "./icon";
import { LoadSection } from "./repo-load";
import { SignInSection } from "./sign-in";

function GitHubControl() {
	const { githubUser, githubOpen } = useStore(shared);

	return (
		<>
			<wa-button id="shell-github" appearance="plain" size="small" title={githubUser !== undefined ? "GitHub · " + githubUser : "GitHub"} aria-label="GitHub"><Icon node={GitBranch} /></wa-button>

			<wa-popover
				for="shell-github"
				placement="bottom-end"
				open={githubOpen}
				onwa-show={(event: Event) => {
					if (event.target === event.currentTarget) {
						shared.set({ "githubOpen": true });
					}
				}}
				onwa-hide={(event: Event) => {
					if (event.target === event.currentTarget) {
						shared.set({ "githubOpen": false });
					}
				}}
			>
				<div class={"wa-stack wa-gap-xs " + popoverBody()} role="group" aria-label="GitHub connection">
					<span class="wa-font-weight-semibold wa-font-size-s">GitHub</span>

					<SignInSection />

					<wa-divider />

					<LoadSection />
				</div>
			</wa-popover>
		</>
	);
}

export const github: ShellFeature = { "control": { "place": "end", "Control": GitHubControl } };

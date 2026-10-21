/** @jsxImportSource preact */
/**
 * The VS Code workbench host.
 *
 * VS Code lays out the workbench itself (the component's "workbench" layout): activity bar, sidebar, editors, panel,
 * auxiliary bar and status bar, with its own sashes, movable views and a remembered layout. This renders the element it
 * mounts into and hands it to `boot()` (via `onReady`), plus the few document-level styles our minimal host.html lacks.
 *
 * Styling is stitches (`theme`), which injects into this document's head — this whole tree is rendered *inside the
 * iframe* by `workbench-entry.tsx`. Its global styles here are over VS Code's CSS, which isn't layered and outranks every
 * layer, so they're `unlayeredGlobalCss`: theme/stitches' one way out of the layers. They're the theme's
 * (theme/styles/workbench), as all of the app's styles are.
 */
import { classicLook, injectGlobals, mountCss } from "theme/styles/workbench";

/** Render the element the workbench mounts into, and report it once mounted. */
export function Workbench({ onReady }: { "onReady": (container: HTMLElement) => void }) {
	injectGlobals();
	classicLook();

	return (
		<main
			class={mountCss()}
			ref={(element) => {
				if (element !== null) {
					onReady(element);
				}
			}}
		/>
	);
}

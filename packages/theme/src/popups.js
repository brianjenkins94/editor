/**
 * A popup still open as its page goes away would keep the page. Web Awesome's wa-popup (in a dropdown, a popover, a
 * select) places itself with Floating UI's autoUpdate, which listens for scroll and resize on every ancestor that can move
 * it — across frames, up to the top window's visualViewport — and stops only when the popup closes or leaves its document.
 * A frame that's removed or goes somewhere else does neither, so its listener on the window above holds its whole realm
 * (2026-11-17: an editor's Share popover or Run menu, open as a test let its window go, kept that editor in the page
 * around it, 80–110 MB each). So each is stopped as its page is hidden for good — not one kept to go back to (the
 * back/forward cache), which comes back as it was. Loaded by the components that open one.
 */

/** Every wa-popup under `root`, in shadow roots too (each component keeps its own in its own). */
function popupsUnder(root, found = []) {
	for (const element of root.querySelectorAll("*")) {
		if (element.localName === "wa-popup") {
			found.push(element);
		}

		if (element.shadowRoot !== null) {
			popupsUnder(element.shadowRoot, found);
		}
	}

	return found;
}

if (typeof window !== "undefined") {
	window.addEventListener("pagehide", (event) => {
		if (!event.persisted) {
			for (const popup of popupsUnder(document)) {
				// (its listeners go at once; what it waits a frame for after is never needed)
				void popup.stop?.();
			}
		}
	});
}

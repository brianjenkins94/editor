/**
 * The one direct call between the shell and the workbench realms: a dock panel shown in a VS Code editor (the
 * component's hosted editors, one slot per panel). Element references can't cross the hub, so the shell offers this on
 * its window, and the workbench hands it each editor's container to move the panel's frame into. Its own module, so
 * the workbench imports neither the shell nor dockview to reach it.
 */

/** The key on the shell's window of what it offers the workbench (`window.top[SHELL_DOCK_HOST]`). */
export const SHELL_DOCK_HOST = "__shellDock";

export interface ShellDockHost {
	/** Show slot `slot` in `container` — when its editor opens, and again whenever it moves to another group. */
	"attach": (slot: string, container: HTMLElement) => { "dispose": () => void };
	/** Slot `slot`'s editor was closed. */
	"closed": (slot: string) => void;
}

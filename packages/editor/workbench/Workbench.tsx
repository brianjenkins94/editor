/** @jsxImportSource preact */
import { classicLook, injectGlobals, mountCss } from "theme/styles/workbench";

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

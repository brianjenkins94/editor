/** @jsxImportSource preact */
import type { ShellFeature } from "./feature";
import { useEffect } from "preact/hooks";
import { errorNotice } from "theme/styles/shell";
import { createStore, useStore } from "./feature";
import "theme/components/callout";

const state = createStore<{ "id"?: string }>({});

function ErrorNotice() {
	const { id } = useStore(state);

	useEffect(() => {
		if (id === undefined) {
			return;
		}

		const timer = setTimeout(() => {
			state.set({ "id": undefined });
		}, 60_000);

		return () => {
			clearTimeout(timer);
		};
	}, [id]);

	if (id === undefined) {
		return null;
	}

	return (
		<wa-callout variant="danger" size="small" class={errorNotice()}>
			<div class="wa-stack wa-gap-2xs">
				<span>Something went wrong, and we've been told. If you get in touch about it, quote <strong>{id}</strong>.</span>

				<wa-button size="small" appearance="plain" onClick={() => { state.set({ "id": undefined }); }}>Dismiss</wa-button>
			</div>
		</wa-callout>
	);
}

export const errorReports: ShellFeature = {
	"start": ({ hub }) => {
		void import("./reporting").then(({ startReporting }) => {
			startReporting(hub, (id) => {
				state.set({ "id": id });
			});
		});
	},
	"Overlay": ErrorNotice
};

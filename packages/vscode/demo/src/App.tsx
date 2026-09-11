import React, { useState } from "react";

// Edit this component in the editor and save — the live preview hot-reloads while the count below KEEPS its
// value (React Fast Refresh, not a full reload). That's the preview pane running the workspace through an
// in-browser Vite dev server (no backend).
export function App() {
	const [count, setCount] = useState(0);

	return (
		<div style={{ "fontFamily": "system-ui, sans-serif", "padding": 24, "lineHeight": 1.5 }}>
			<h1>Live Preview 👋</h1>
			<p>
				Edit <code>src/App.tsx</code> and save — the preview updates instantly.
			</p>
			<button type="button" onClick={() => setCount((value) => value + 1)}>
				count is {count}
			</button>
		</div>
	);
}

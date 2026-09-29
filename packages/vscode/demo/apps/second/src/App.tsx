import React, { useState } from "react";

// A SECOND runnable app in the same workspace. Run its `dev` script alongside the root demo's and both previews
// open at once — each on its own port + movable window — proving multiple concurrent dev servers (multi-server
// apps, multiplayer games) coexist in the editor.
export function App() {
	const [ticks, setTicks] = useState(0);

	return (
		<div style={{ "fontFamily": "system-ui, sans-serif", "padding": 24, "lineHeight": 1.5, "background": "#0f766e", "color": "white", "minHeight": "100vh" }}>
			<h1>Second App 🛰️</h1>
			<p>
				This is a different package (<code>apps/second</code>) on its own preview port.
			</p>
			<button type="button" onClick={() => setTicks((value) => value + 1)} style={{ "padding": "6px 12px", "borderRadius": 6, "border": "none", "cursor": "pointer" }}>
				ticks: {ticks}
			</button>
		</div>
	);
}

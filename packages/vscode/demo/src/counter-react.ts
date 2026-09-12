// Debug this with the tsval debugger (Run and Debug → tsval). It renders through the M3c reconciler in the
// worker and streams to the debug preview; React + ReactDOM are provided by the debugger (no imports needed).
// Set a breakpoint in `increment` and click the button — execution pauses INSIDE the handler (M3b Atomics),
// and time-travel rewinds `count` (M3d).
declare const React: { "useState": <S>(initial: S) => [S, (next: S) => void]; "createElement": (...args: unknown[]) => unknown };
declare const ReactDOM: { "createRoot": (container: unknown) => { "render": (element: unknown) => void } };

function App() {
	const [count, setCount] = React.useState(0);

	const increment = () => setCount(count + 1);

	return React.createElement("button", { "onClick": increment, "id": "btn" }, "count is " + count);
}

ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(App));

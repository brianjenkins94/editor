// A self-contained sample for the tsval debugger (no imports — runs entirely under the interpreter).
// Set a breakpoint on a line inside `add`, then Run and Debug (tsval): execution pauses there and the
// Variables pane shows the real locals (a, b, sum) from tsval's own scope.

function add(a: number, b: number): number {
	const sum = a + b;

	return sum;
}

const x = 10;
const y = 32;
const result = add(x, y);
const doubled = result * 2;

result;
doubled;

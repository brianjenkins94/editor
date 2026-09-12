// A self-contained sample for the tsval debugger (no imports — runs entirely under the interpreter).
//
// Try it: set a breakpoint on the `total += n` line, then Run and Debug (tsval). Step forward through the
// loop and watch `total` and `i` climb — then use Step Back / Reverse (the tsval debugger supports time
// travel) and watch them run BACKWARD. The Variables pane reflects tsval's real machine state at every point.

function sum(numbers: number[]): number {
	let total = 0;

	for (let i = 0; i < numbers.length; i++) {
		const n = numbers[i];

		total += n;
	}

	return total;
}

const values = [10, 20, 30];
const result = sum(values);

result;

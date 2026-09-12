// The tsval debugger can pause INSIDE host-invoked callbacks (M3b): forEach is a native (host) function
// that calls the guest arrow synchronously — the same shape as React calling an onClick. Set a breakpoint
// on the `total += n` line, Run and Debug (tsval), and it pauses INSIDE the callback each iteration: the
// worker blocks on Atomics while you inspect, then resumes. (A plain for-loop pauses at the top level too.)

const values = [10, 20, 30];
let total = 0;

values.forEach((n) => {
	total += n;
});

total;

/** Pure numeric helpers — no dependencies, so they resolve entirely from the in-memory snapshot. */

export function sum(values: readonly number[]): number {
	return values.reduce((total, value) => total + value, 0);
}

export function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

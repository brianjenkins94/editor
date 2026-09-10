const target = new URL("./fast-record.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
	if (specifier === "@bablr/record") {
		return { "url": target, "shortCircuit": true };
	}

	return nextResolve(specifier, context);
}

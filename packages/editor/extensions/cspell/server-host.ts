import { createRuntime, VirtualFS } from "@brianjenkins94/almostnode";
import { failureText } from "@brianjenkins94/editor-api/failures";
import serverNodeCode from "cspell:server-node";
import { DICTIONARIES, servedName } from "./dictionaries";


async function main(): Promise<void> {
	const vfs = new VirtualFS();

	const here = import.meta.url;

	vfs.mkdirSync("/dicts", { "recursive": true });
	await Promise.all(DICTIONARIES.map(async (dictionary) => {
		const dictUrl = new URL("./dicts/" + servedName(dictionary), here);
		const bytes = await fetch(dictUrl).then((response) => {
			if (!response.ok) {
				throw new Error(`dict fetch ${response.status} ${dictUrl.href}`);
			}

			return response.arrayBuffer();
		});

		vfs.writeFileSync("/dicts/" + servedName(dictionary), new Uint8Array(bytes));
	}));
	vfs.writeFileSync("/server-node.ts", serverNodeCode);

	const hereUrl = new URL(here);
	const vscodeCut = hereUrl.pathname.indexOf("/__vscode__/");
	const base = hereUrl.origin + (vscodeCut === -1 ? "/" : hereUrl.pathname.slice(0, vscodeCut + 1));
	const runtime = await createRuntime(vfs, { "dangerouslyAllowSameOrigin": true, "base": base });

	await runtime.runFile("/server-node.ts");
}

await main().catch((error: unknown) => {
	console.error("[cspell/server-host] failed to start cspell server under almostnode:", failureText(error));
});

/**
 * How a mocked process.argv is read (the notes margin's Mock, LIVE-VALUES.md): as a command line, a run's arguments
 * separated by spaces, quotes keeping a space in one; `|` separates runs.
 */

/** `a "b c" | d` → [["a", "b c"], ["d"]]; nothing → one run, with none. */
export function parseInputs(text: string): string[][] {
	const runs: string[][] = [[]];
	let [word, quote, inWord] = ["", "", false];
	const end = (): void => {
		if (inWord) {
			runs.at(-1)!.push(word);
		}

		[word, inWord] = ["", false];
	};

	for (const char of text) {
		if (quote !== "") {
			if (char === quote) {
				quote = "";
			} else {
				word += char;
			}
		} else if (char === "\"" || char === "'") {
			[quote, inWord] = [char, true];
		} else if (char === "|") {
			end();
			runs.push([]);
		} else if (/\s/u.test(char)) {
			end();
		} else {
			word += char;
			inWord = true;
		}
	}

	end();

	return runs;
}

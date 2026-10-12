/** The terminal's `open`: `code`'s opener (../code), and a URL opened in the browser, as macOS's `open` would. */
import type { Command } from "just-bash/browser";
import type { CommandHost } from "../../catalog";
import { opener } from "../code/code";

export function create(host: CommandHost): Command {
	return opener("open", host, { "urls": true });
}

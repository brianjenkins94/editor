/** The terminal's `open`: `code`'s opener (../code), and a URL opened in the browser, as macOS's `open` would. */
import type { CommandHost, Handler } from "../../catalog";
import { opener } from "../code/code";

export function create(host: CommandHost): Handler {
	return opener("open", host, { "urls": true });
}

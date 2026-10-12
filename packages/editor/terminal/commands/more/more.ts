/** The terminal's `more`: `less` (../less) by its other name. */
import type { Command } from "just-bash/browser";
import { pager } from "../less/less";

export function create(): Command {
	return pager("more");
}

/** The terminal's `more`: `less` (../less) by its other name. */
import type { Handler } from "../../catalog";
import { pager } from "../less/less";

export function create(): Handler {
	return pager("more");
}

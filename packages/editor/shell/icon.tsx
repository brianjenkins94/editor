/** @jsxImportSource preact */
import { iconSvg } from "../shared/theme";

/** A lucide icon rendered into a Web Awesome button. */
export function Icon({ node }: { "node": Parameters<typeof iconSvg>[0] }) {
	return <span dangerouslySetInnerHTML={{ "__html": iconSvg(node, { "size": 17 }) }} />;
}

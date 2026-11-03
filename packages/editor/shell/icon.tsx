/** @jsxImportSource preact */
/**
 * The shell's icons: lucide's, each a plain list of SVG children rendered by lucide's own `createElement`. They're
 * stroked with `currentColor`, so an icon takes the colour of the text around it.
 */
import { createElement } from "lucide";

/** lucide's per-icon shape: a flat list of SVG children as [tag, attributes] pairs (structurally lucide's own
 *  `IconNode`). */
type IconNode = readonly [tag: string, attrs: Record<string, string | number>][];

/** A lucide icon as SVG markup, `size` px square (lucide's 24px artboard scaled). */
function iconSvg(node: IconNode, size: number): string {
	return createElement(node as never, { "width": size, "height": size }).outerHTML;
}

/** A lucide icon rendered into a Web Awesome button. */
export function Icon({ node }: { "node": IconNode }) {
	return <span dangerouslySetInnerHTML={{ "__html": iconSvg(node, 17) }} />;
}

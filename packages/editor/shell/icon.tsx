/** @jsxImportSource preact */
import { createElement } from "lucide";

type IconNode = readonly [tag: string, attrs: Record<string, string | number>][];

function iconSvg(node: IconNode, size: number): string {
	return createElement(node as never, { "width": size, "height": size }).outerHTML;
}

export function Icon({ node }: { "node": IconNode }) {
	return <span dangerouslySetInnerHTML={{ "__html": iconSvg(node, 17) }} />;
}

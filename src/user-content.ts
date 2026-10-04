import type { TextContent } from "@earendil-works/pi-ai";
import type { TextBlockParam } from "@anthropic-ai/sdk/resources";

export type BridgeTextContent = TextContent & Pick<TextBlockParam, "cache_control" | "citations">;

export function userTextBlock(block: BridgeTextContent): TextBlockParam {
	return {
		type: "text",
		text: block.text,
		...(block.cache_control !== undefined ? { cache_control: block.cache_control === null ? null : { ...block.cache_control } } : {}),
		...(block.citations !== undefined ? { citations: block.citations } : {}),
	};
}

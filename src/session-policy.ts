import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { z } from "zod";

const TurnOptions = z.object({
	turnId: z.string().regex(/\S/, "A Claude bridge turn needs a nonempty transport turnId"),
	cachePolicy: z.enum(["native", "optchat"]).optional(),
});
export type OptChatTurnOptions = z.infer<typeof TurnOptions>;
const SessionPolicy = TurnOptions.extend({ kind: z.literal("fresh-turn"), sessionKey: z.string() });
export type TurnSessionPolicy = z.infer<typeof SessionPolicy>;

export function createTurnSessionPolicy(options: OptChatTurnOptions & Pick<TurnSessionPolicy, "sessionKey">): TurnSessionPolicy {
	return Object.freeze(SessionPolicy.parse({ ...options, kind: "fresh-turn" }));
}

export function turnQueryOptions(options: Options, policy?: TurnSessionPolicy): Options {
	if (policy?.cachePolicy !== "optchat") return options;
	const env = options.env ?? {};
	const raw = env.CLAUDE_CODE_EXTRA_BODY;
	const extraBody = z.record(z.string(), z.unknown()).parse(raw ? JSON.parse(raw) : {});
	return {
		...options,
		env: {
			...env,
			DISABLE_PROMPT_CACHING: "1",
			CLAUDE_CODE_EXTRA_BODY: JSON.stringify({ ...extraBody, cache_control: { type: "ephemeral", ttl: "5m" } }),
		},
	};
}

export function turnStreamOptions(options: SimpleStreamOptions | undefined, policy: TurnSessionPolicy): SimpleStreamOptions {
	return { ...options, sessionId: policy.sessionKey };
}

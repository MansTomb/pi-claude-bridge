import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";

export type TurnSessionPolicy = {
	readonly kind: "fresh-turn";
	readonly turnId: string;
	readonly sessionKey: string;
};

export function createTurnSessionPolicy({ turnId, sessionKey }: { turnId: string; sessionKey: string }): TurnSessionPolicy {
	if (!turnId.trim()) throw new Error("A Claude bridge turn needs a nonempty transport turnId");
	return Object.freeze({ kind: "fresh-turn", turnId, sessionKey });
}

export function turnStreamOptions(options: SimpleStreamOptions | undefined, policy: TurnSessionPolicy): SimpleStreamOptions {
	return { ...options, sessionId: policy.sessionKey };
}

export function optChatQueryOptions(options: Options): Options {
	const env = options.env ?? {};
	const raw = env.CLAUDE_CODE_EXTRA_BODY;
	const extraBody: unknown = raw ? JSON.parse(raw) : {};
	if (extraBody === null || typeof extraBody !== "object" || Array.isArray(extraBody)) {
		throw new Error("OptChat requires CLAUDE_CODE_EXTRA_BODY to be a JSON object");
	}
	return {
		...options,
		env: {
			...env,
			DISABLE_PROMPT_CACHING: "1",
			CLAUDE_CODE_EXTRA_BODY: JSON.stringify({ ...extraBody, cache_control: { type: "ephemeral", ttl: "5m" } }),
		},
	};
}

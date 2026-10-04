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

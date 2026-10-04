import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { query, type Options, type Query } from "@anthropic-ai/claude-agent-sdk";
import type { Tool } from "@earendil-works/pi-ai";
import { z } from "zod";
import { createToolServer } from "./mcp-server.js";
import { MCP_SERVER_NAME } from "./skills.js";

export interface CacheRefreshSnapshot {
	options: Options;
	tools: Tool[];
	sessionId: string;
	checkpoint: string;
}

export type CacheRefreshResult =
	| { kind: "refreshed"; cacheRead: number; cacheWrite: number; input: number }
	| { kind: "unsupported"; reason: string };

const responseStart = z.object({
	type: z.literal("stream_event"),
	event: z.object({
		type: z.literal("message_start"),
		message: z.object({ usage: z.object({
			input_tokens: z.number(),
			cache_read_input_tokens: z.number().optional(),
			cache_creation_input_tokens: z.number().optional(),
		}) }),
	}),
});

export async function refreshCache(snapshot: CacheRefreshSnapshot, signal?: AbortSignal): Promise<CacheRefreshResult> {
	signal?.throwIfAborted();
	const controller = new AbortController();
	let child: ChildProcessWithoutNullStreams | undefined;
	let exited: Promise<void> = Promise.resolve();
	let result: CacheRefreshResult | undefined;
	let sdkQuery: Query | undefined;
	const stop = () => {
		child?.kill("SIGKILL");
		controller.abort();
	};
	const timer = setTimeout(stop, 20_000);
	signal?.addEventListener("abort", stop, { once: true });
	try {
		const mcpServers = snapshot.tools.length ? {
			[MCP_SERVER_NAME]: createToolServer(MCP_SERVER_NAME, snapshot.tools.map(tool => ({
				name: tool.name, description: tool.description, inputSchema: tool.parameters,
				handler: async () => { stop(); throw new Error("Cache refresh cannot execute tools"); },
			}))),
		} : undefined;
		sdkQuery = query({
			prompt: "[Refresh the prompt cache.]",
			options: {
				...snapshot.options,
				resume: snapshot.sessionId,
				resumeSessionAt: snapshot.checkpoint,
				forkSession: true,
				persistSession: false,
				mcpServers,
				maxTurns: 1,
				abortController: controller,
				env: { ...snapshot.options.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: "1", CLAUDE_CODE_MAX_RETRIES: "0" },
				spawnClaudeCodeProcess: options => {
					child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, stdio: "pipe" });
					exited = new Promise(resolve => { child?.once("exit", () => resolve()); child?.once("error", () => resolve()); });
					let pending = "";
					child.stdout.on("data", (data: Buffer) => {
						pending += data.toString();
						let newline: number;
						while ((newline = pending.indexOf("\n")) >= 0) {
							const line = pending.slice(0, newline);
							pending = pending.slice(newline + 1);
							let value: unknown;
							try { value = JSON.parse(line); } catch { continue; }
							const parsed = responseStart.safeParse(value);
							if (!parsed.success || result) continue;
							const usage = parsed.data.event.message.usage;
							result = { kind: "refreshed", input: usage.input_tokens, cacheRead: usage.cache_read_input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0 };
							stop();
						}
					});
					child.stderr.on("data", () => {});
					return child;
				},
			},
		});
		for await (const _message of sdkQuery) {}
	} catch (error) {
		if (!result) throw error;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", stop);
		stop();
		sdkQuery?.close();
		await exited;
	}
	signal?.throwIfAborted();
	if (!result) throw new Error("Cache refresh ended before receiving a provider response");
	return result;
}

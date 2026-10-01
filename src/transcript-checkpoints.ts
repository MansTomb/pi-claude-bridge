import { createHash, type Hash } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getProjectDir, getSessionPath, serializeRecord, type JsonlRecord } from "cc-session-io";

export interface Checkpoint {
	length: number;
	hash: string;
	leaf: string;
	trailingAssistant: boolean;
}

export interface PersistedSession {
	sessionId: string;
	checkpoints: Checkpoint[];
}

type FingerprintedMessage = { role?: unknown; content?: unknown; toolCallId?: unknown; toolName?: unknown; isError?: unknown };

export const CHECKPOINT_LIMIT = 16;

function updateFingerprint(hash: Hash, message: unknown): void {
	const record = message as FingerprintedMessage;
	hash.update(JSON.stringify([record.role, record.content, record.toolCallId, record.toolName, record.isError]));
	hash.update("\u0000");
}

export function fingerprintMessages(messages: readonly unknown[]): string {
	const hash = createHash("sha1");
	for (const message of messages) updateFingerprint(hash, message);
	return hash.digest("hex");
}

export function prefixFingerprints(messages: readonly unknown[], lengths: Iterable<number>): Map<number, string> {
	const wanted = new Set([...lengths].filter((length) => length >= 0 && length <= messages.length));
	const result = new Map<number, string>();
	const hash = createHash("sha1");
	if (wanted.has(0)) result.set(0, hash.copy().digest("hex"));
	messages.forEach((message, index) => {
		updateFingerprint(hash, message);
		if (wanted.has(index + 1)) result.set(index + 1, hash.copy().digest("hex"));
	});
	return result;
}

export function bestCheckpoint(
	checkpoints: readonly Checkpoint[],
	messages: readonly unknown[],
): { checkpoint: Checkpoint; consumed: number } | undefined {
	const fingerprints = prefixFingerprints(messages, checkpoints.map((checkpoint) => checkpoint.length));
	let best: { checkpoint: Checkpoint; consumed: number } | undefined;
	for (const checkpoint of checkpoints) {
		if (fingerprints.get(checkpoint.length) !== checkpoint.hash) continue;
		if (checkpoint.trailingAssistant && (messages[checkpoint.length] as FingerprintedMessage | undefined)?.role !== "assistant") continue;
		const consumed = checkpoint.length + (checkpoint.trailingAssistant ? 1 : 0);
		if (!best || consumed > best.consumed) best = { checkpoint, consumed };
	}
	return best;
}

export function appendCheckpoint(checkpoints: readonly Checkpoint[], checkpoint: Checkpoint): Checkpoint[] {
	return [...checkpoints.filter((existing) => existing.leaf !== checkpoint.leaf), checkpoint].slice(-CHECKPOINT_LIMIT);
}

function readRecords(path: string): JsonlRecord[] {
	const records: JsonlRecord[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			records.push(JSON.parse(line) as JsonlRecord);
		} catch {
			continue;
		}
	}
	return records;
}

export function readChain(sessionId: string, cwd: string, claudeDir: string | undefined, leaf: string): JsonlRecord[] | undefined {
	const path = getSessionPath(sessionId, cwd, claudeDir);
	if (!existsSync(path)) return undefined;
	const byUuid = new Map<string, JsonlRecord>();
	for (const record of readRecords(path)) {
		const uuid = (record as { uuid?: unknown }).uuid;
		if (typeof uuid === "string") byUuid.set(uuid, record);
	}
	const chain: JsonlRecord[] = [];
	let cursor: string | null | undefined = leaf;
	while (cursor) {
		const record = byUuid.get(cursor);
		if (!record) return undefined;
		chain.push(record);
		cursor = (record as { parentUuid?: string | null }).parentUuid;
	}
	return chain.reverse();
}

function writeAtomically(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, text);
	renameSync(temporary, path);
}

export function writeTranscript(
	sessionId: string,
	cwd: string,
	claudeDir: string | undefined,
	chain: readonly JsonlRecord[],
	appended: readonly JsonlRecord[],
): string {
	const leaf = (chain.at(-1) as { uuid: string }).uuid;
	const tail = appended.map((record, index) =>
		index === 0 ? { ...record, parentUuid: leaf } : record,
	);
	const lines = [...chain, ...tail].map((record) => serializeRecord({ ...record, sessionId } as JsonlRecord));
	writeAtomically(getSessionPath(sessionId, cwd, claudeDir), `${lines.join("\n")}\n`);
	return ((tail.at(-1) ?? chain.at(-1)) as { uuid: string }).uuid;
}

function sidecarPath(sessionKey: string, cwd: string, claudeDir: string | undefined): string {
	return join(getProjectDir(cwd, claudeDir), "pi-claude-bridge", `${sessionKey.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

export function readPersistedSession(sessionKey: string, cwd: string, claudeDir: string | undefined): PersistedSession | undefined {
	const path = sidecarPath(sessionKey, cwd, claudeDir);
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as PersistedSession;
		if (typeof parsed.sessionId !== "string" || !Array.isArray(parsed.checkpoints)) return undefined;
		if (!existsSync(getSessionPath(parsed.sessionId, cwd, claudeDir))) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

export function writePersistedSession(sessionKey: string, cwd: string, claudeDir: string | undefined, session: PersistedSession): void {
	writeAtomically(sidecarPath(sessionKey, cwd, claudeDir), JSON.stringify(session));
}

export function readSessionHeaderId(sessionFile: string): string | undefined {
	try {
		const firstLine = readFileSync(sessionFile, "utf8").split("\n", 1)[0];
		const header = JSON.parse(firstLine) as { type?: string; id?: unknown };
		return header.type === "session" && typeof header.id === "string" ? header.id : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Session + memory persistence for the agent.
 *
 * Three kinds of durable state are managed here:
 *
 *  1. SESSION  — `<workspace>/.ai-agent-chat/session.json`
 *     A JSON snapshot of everything needed to resume a conversation exactly
 *     where it left off after a VS Code restart or window reload: the model
 *     message `history` (the agent's actual context), the `uiLog` (what was
 *     rendered in the chat view), the session `todoList`, and the last
 *     `selectedModel`. This is the "current context" the user asked to keep
 *     up to date and recover on startup.
 *
 *  2. FOLDER MEMORY — `<workspace>/{memoryFile}` (default `AGENTS.md`)
 *     A free-form markdown file holding the agent's own "internal
 *     understandings" about THIS workspace and the work in progress in it. It
 *     is loaded on startup, injected into the system prompt every turn, and
 *     kept up to date during a run via the `update_memory` tool (scope
 *     "folder", the default). It survives across sessions so knowledge
 *     accumulates — but it is scoped to a single project, so memory from one
 *     project never leaks into another.
 *
 *  3. GLOBAL MEMORY — `<globalStorage>/{globalMemoryFile}` (default
 *     `GLOBAL_AGENTS.md`), i.e. a single machine-wide file living in the
 *     extension's global storage directory, OUTSIDE any workspace. It holds
 *     cross-project notes the agent wants to remember regardless of which
 *     folder is open (conventions, tooling preferences, recurring gotchas).
 *     It is loaded on startup, injected into the system prompt every turn,
 *     and updated via `update_memory` with scope "global". Because it lives
 *     outside the workspace, it is shared across every project on the machine
 *     while each project keeps its own independent folder memory.
 *
 * Design notes:
 *   - Pure helpers (`serializeSession`, `parseSession`, `buildMemoryPrompt`,
 *     `buildGlobalMemoryPrompt`, `resolveContainedPath`,
 *     `stripToPersistableHistory`) take/return plain data and have NO vscode
 *     or fs dependency, so they are unit-testable with plain Node. The fs I/O
 *     wrappers are thin and also dependency-free.
 *   - Session writes are atomic (temp file + rename on the same volume) so a
 *     crash mid-write cannot corrupt the existing session.
 *   - The folder memory file is contained within the workspace root; its name
 *     is configurable but must not escape the workspace. The global memory
 *     file lives in a directory passed in by the caller (the extension host
 *     supplies `context.globalStorageUri.fsPath`), so this module stays
 *     vscode-free.
 */

import * as fs from "fs";
import * as path from "path";
import type { ChatMessage } from "./apiClient";
import type { TodoItem } from "./tools/todos";

/** Directory (inside the workspace) that holds session state. */
export const SESSION_DIR = ".ai-agent-chat";
/** Session snapshot file name, inside {@link SESSION_DIR}. */
export const SESSION_FILE = "session.json";
/** Default folder (per-workspace) memory file name (workspace-relative). */
export const DEFAULT_MEMORY_FILE = "AGENTS.md";
/**
 * Default global (cross-project) memory file name. Lives in the extension's
 * global storage directory (outside any workspace), passed in by the caller.
 */
export const DEFAULT_GLOBAL_MEMORY_FILE = "GLOBAL_AGENTS.md";

/** Bumped on incompatible changes to the session schema. */
export const SESSION_VERSION = 1;
/** Hard cap on the serialized session size, to avoid unbounded growth. */
export const MAX_SESSION_BYTES = 8 * 1024 * 1024;
/** Soft cap on injected memory size (the rest is truncated with a notice). */
export const MAX_MEMORY_BYTES = 64 * 1024;

/** A single rendered chat-view line, replayed on webview restore. */
export interface UiLogEntry {
	role: string;
	text: string;
}

/** The full resumable session snapshot. */
export interface SessionState {
	version: number;
	history: ChatMessage[];
	uiLog: UiLogEntry[];
	todoList: TodoItem[];
	selectedModel: string;
	savedAt: number;
}

/**
 * Pure path-containment check (no vscode dependency). Resolves `relPath`
 * against `root` and throws if the result escapes the root. Mirrors
 * tools.ts#resolvePathInRoot but is kept local so this module stays
 * dependency-free and unit-testable in isolation.
 */
export function resolveContainedPath(root: string, relPath: string): string {
	const abs = path.resolve(root, relPath);
	const rel = path.relative(root, abs);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new Error(`Path escapes the workspace: ${relPath}`);
	}
	return abs;
}

/** Absolute path to the session file for a given workspace root. */
export function getSessionPath(root: string): string {
	return path.join(root, SESSION_DIR, SESSION_FILE);
}

/** Absolute path to the folder memory file for a given workspace root + file name. */
export function getMemoryPath(root: string, memoryFile: string): string {
	const name = (memoryFile || "").trim() || DEFAULT_MEMORY_FILE;
	return resolveContainedPath(root, name);
}

/**
 * Absolute path to the GLOBAL memory file for a given global-storage directory
 * + file name. Unlike {@link getMemoryPath}, the directory is NOT a workspace
 * root — it is the extension's machine-wide `globalStorageUri.fsPath`, supplied
 * by the host — so there is intentionally no workspace-containment check here
 * (global memory is supposed to live outside any single project). The file
 * name is contained to the provided directory (it may not escape it) to keep
 * it a single well-known file. Pure.
 */
export function getGlobalMemoryPath(globalDir: string, memoryFile: string): string {
	const dir = (globalDir || "").trim();
	if (!dir) {
		throw new Error("Global memory directory is not available (no global storage path).");
	}
	const name = (memoryFile || "").trim() || DEFAULT_GLOBAL_MEMORY_FILE;
	// Contain the NAME to the directory (a bare file name is always fine, but
	// reject anything that tries to escape the global-storage folder).
	const abs = path.resolve(dir, name);
	const rel = path.relative(dir, abs);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new Error(`Global memory file escapes the storage directory: ${name}`);
	}
	return abs;
}

/**
 * Strip messages that the API cannot replay on resume: tool-result messages
 * whose preceding tool_call was dropped, and tool_call/assistant messages with
 * no recoverable content. Kept simple and conservative: a tool message is kept
 * only when the immediately preceding kept message is an assistant message that
 * carries tool_calls. Pure.
 */
export function stripToPersistableHistory(history: ChatMessage[]): ChatMessage[] {
	const out: ChatMessage[] = [];
	for (const msg of history) {
		if (msg.role === "tool") {
			const prev = out[out.length - 1];
			if (prev && prev.role === "assistant" && Array.isArray(prev.tool_calls) && prev.tool_calls.length > 0) {
				out.push(msg);
			}
			// otherwise drop the orphaned tool result
			continue;
		}
		out.push(msg);
	}
	return out;
}

/** Serialize a session snapshot to a pretty-printed JSON string. Pure. */
export function serializeSession(session: SessionState): string {
	return JSON.stringify(session, null, 2);
}

/**
 * Parse and validate a raw session JSON string. Returns null for a missing or
 * corrupt file (never throws). Pure.
 */
export function parseSession(raw: string): SessionState | null {
	if (!raw || !raw.trim()) {
		return null;
	}
	let parsed: any;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") {
		return null;
	}
	if (parsed.version !== SESSION_VERSION) {
		// Unknown/older schema: don't silently migrate something we don't understand.
		return null;
	}
	const history = Array.isArray(parsed.history) ? parsed.history.filter(isPersistableMessage) : [];
	const uiLog = Array.isArray(parsed.uiLog) ? parsed.uiLog.filter(isUiLogEntry) : [];
	const todoList = Array.isArray(parsed.todoList) ? parsed.todoList.filter(isTodoItem) : [];
	const selectedModel = typeof parsed.selectedModel === "string" ? parsed.selectedModel : "";
	const savedAt = typeof parsed.savedAt === "number" ? parsed.savedAt : 0;
	return { version: SESSION_VERSION, history, uiLog, todoList, selectedModel, savedAt };
}

function isPersistableMessage(m: any): boolean {
	return m && typeof m === "object" && typeof m.role === "string";
}
function isUiLogEntry(e: any): boolean {
	return e && typeof e === "object" && typeof e.role === "string" && typeof e.text === "string";
}
function isTodoItem(t: any): boolean {
	return t && typeof t === "object" && typeof t.id === "string" && typeof t.content === "string";
}

/** Load the session snapshot for a workspace root, or null if absent/corrupt. */
export function loadSession(root: string): SessionState | null {
	const file = getSessionPath(root);
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
	return parseSession(raw);
}

/**
 * Persist a session snapshot atomically. Returns true on success, false on
 * failure (logged by the caller). Creates the session directory as needed.
 */
export function saveSession(root: string, session: SessionState): boolean {
	const file = getSessionPath(root);
	const dir = path.dirname(file);
	try {
		fs.mkdirSync(dir, { recursive: true });
		const data = serializeSession(session);
		if (Buffer.byteLength(data, "utf8") > MAX_SESSION_BYTES) {
			// Refuse to write an oversized session rather than silently truncating
			// history mid-structure. The caller can compact first.
			return false;
		}
		const tmp = file + ".tmp";
		fs.writeFileSync(tmp, data, "utf8");
		fs.renameSync(tmp, file);
		return true;
	} catch {
		return false;
	}
}

/** Delete the session file (used by "Clear Chat"). No-op if absent. */
export function clearSession(root: string): void {
	const file = getSessionPath(root);
	try {
		fs.rmSync(file, { force: true });
	} catch {
		// ignore
	}
}

/** Load the folder memory file for a workspace root, or "" if absent. */
export function loadMemory(root: string, memoryFile: string): string {
	const file = getMemoryPath(root, memoryFile);
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

/**
 * Write the folder memory file for a workspace root. Creates parent directories
 * as needed. Returns true on success. Throws on containment failure (caught by
 * the caller). Bounded by {@link MAX_MEMORY_BYTES}.
 */
export function saveMemory(root: string, memoryFile: string, content: string): boolean {
	const file = getMemoryPath(root, memoryFile);
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const bounded = Buffer.byteLength(content, "utf8") > MAX_MEMORY_BYTES
			? content.slice(0, MAX_MEMORY_BYTES)
			: content;
		fs.writeFileSync(file, bounded, "utf8");
		return true;
	} catch {
		return false;
	}
}

/** Load the global memory file from a global-storage directory, or "" if absent. */
export function loadGlobalMemory(globalDir: string, memoryFile: string): string {
	const file = getGlobalMemoryPath(globalDir, memoryFile);
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

/**
 * Write the global memory file to a global-storage directory. Creates the
 * directory as needed. Returns true on success. Throws on path/containment
 * failure (caught by the caller). Bounded by {@link MAX_MEMORY_BYTES}.
 */
export function saveGlobalMemory(globalDir: string, memoryFile: string, content: string): boolean {
	const file = getGlobalMemoryPath(globalDir, memoryFile);
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const bounded = Buffer.byteLength(content, "utf8") > MAX_MEMORY_BYTES
			? content.slice(0, MAX_MEMORY_BYTES)
			: content;
		fs.writeFileSync(file, bounded, "utf8");
		return true;
	} catch {
		return false;
	}
}

/**
 * Format the agent's persistent FOLDER (per-workspace) memory for injection
 * into the system prompt. Returns "" when there is no memory yet. Pure.
 */
export function buildMemoryPrompt(memory: string): string {
	const trimmed = (memory || "").trim();
	if (!trimmed) {
		return "";
	}
	let body = trimmed;
	if (Buffer.byteLength(body, "utf8") > MAX_MEMORY_BYTES) {
		body = body.slice(0, MAX_MEMORY_BYTES) + "\n\n[... memory truncated to fit context ...]";
	}
	return (
		"\n\n" +
		"<agent_memory>\n" +
		"The block below is YOUR persistent memory / internal understanding of this " +
		"workspace and the work in progress, kept in a markdown file and loaded on " +
		"startup. Treat it as your own running notes: keep it concise, accurate, and " +
		"current. Update it with the `update_memory` tool whenever you discover " +
		"something worth remembering across sessions (key facts, decisions, file " +
		"layouts, gotchas, outstanding tasks). This is the FOLDER-scoped memory for " +
		"the current project only — do not let it bleed into other projects.\n" +
		"---\n" +
		body + "\n" +
		"</agent_memory>"
	);
}

/**
 * Format the agent's persistent GLOBAL (cross-project) memory for injection
 * into the system prompt. Returns "" when there is no memory yet. Pure.
 *
 * Global memory lives outside any workspace (in the extension's global
 * storage) and is shared across every project on this machine. It is meant
 * for conventions, tooling preferences, and recurring gotchas that are NOT
 * specific to a single project — keeping them here is exactly what prevents
 * one project's notes from leaking into another's folder memory.
 */
export function buildGlobalMemoryPrompt(memory: string): string {
	const trimmed = (memory || "").trim();
	if (!trimmed) {
		return "";
	}
	let body = trimmed;
	if (Buffer.byteLength(body, "utf8") > MAX_MEMORY_BYTES) {
		body = body.slice(0, MAX_MEMORY_BYTES) + "\n\n[... global memory truncated to fit context ...]";
	}
	return (
		"\n\n" +
		"<agent_global_memory>\n" +
		"The block below is YOUR GLOBAL (cross-project) memory — notes shared across " +
		"EVERY project on this machine, kept in a file outside any workspace. Use it " +
		"only for things that are NOT specific to a single project: general " +
		"conventions, tooling preferences, recurring gotchas, and your own working " +
		"style. Keep it concise and current, and update it with the `update_memory` " +
		"tool using scope \"global\". Project-specific facts belong in the FOLDER " +
		"memory (scope \"folder\", the default), not here, so they stay isolated per " +
		"project.\n" +
		"---\n" +
		body + "\n" +
		"</agent_global_memory>"
	);
}

/**
 * A disk-backed read/write store for ONE memory scope. `get`/`set` match the
 * {@link ToolContext} memory accessors (`getMemory`/`setMemory`,
 * `getGlobalMemory`/`setGlobalMemory`) so a store can be wired straight into a
 * tool context with no adapter.
 *
 * The crucial property: **reads always hit disk**. The store keeps NO
 * in-memory snapshot, so it reflects changes written by any path — a manual
 * edit of the file, the `/init` slash command writing `AGENTS.md` via
 * `write_file`, or the `update_memory` tool — rather than a value loaded once
 * at activation and cached. (Caching the contents caused `/config` to report
 * 0 bytes and the system prompt to miss the memory after an external write.)
 */
export interface MemoryStore {
	/** Read the current memory file contents from disk, or "" if absent/unavailable. */
	get(): string;
	/** Overwrite the memory file contents on disk (no-op when the scope is unavailable). */
	set(content: string): void;
}

/**
 * Disk-backed store for the FOLDER (per-workspace) memory file. `getMemoryFile`
 * is read on each call so a `aiAgentChat.memoryFile` setting change takes
 * effect without reactivation. Reads go through {@link loadMemory} ("" when the
 * file is absent) and writes through {@link saveMemory} (bounded, creates
 * parent dirs). Pure (no `vscode` dependency) and unit-testable against a real
 * temp directory.
 */
export function createFolderMemoryStore(
	root: string,
	getMemoryFile: () => string,
): MemoryStore {
	return {
		get: () => loadMemory(root, getMemoryFile()),
		set: (content: string) => {
			saveMemory(root, getMemoryFile(), content);
		},
	};
}

/**
 * Disk-backed store for the GLOBAL (cross-project) memory file. Same
 * disk-as-source-of-truth contract as {@link createFolderMemoryStore}. When the
 * global storage directory is unavailable ("" — no `globalStorageUri`), `get`
 * returns "" and `set` is a no-op, so callers need no separate undefined-dir
 * branch. Pure (no `vscode` dependency) and unit-testable against a real temp
 * directory.
 */
export function createGlobalMemoryStore(
	globalDir: string,
	getMemoryFile: () => string,
): MemoryStore {
	return {
		get: () => (globalDir ? loadGlobalMemory(globalDir, getMemoryFile()) : ""),
		set: (content: string) => {
			if (globalDir) {
				saveGlobalMemory(globalDir, getMemoryFile(), content);
			}
		},
	};
}

import * as assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  SESSION_DIR,
  SESSION_FILE,
  DEFAULT_MEMORY_FILE,
  DEFAULT_GLOBAL_MEMORY_FILE,
  SESSION_VERSION,
  MAX_MEMORY_BYTES,
  resolveContainedPath,
  getSessionPath,
  getMemoryPath,
  getGlobalMemoryPath,
  stripToPersistableHistory,
  serializeSession,
  parseSession,
  loadSession,
  saveSession,
  clearSession,
  loadMemory,
  saveMemory,
  loadGlobalMemory,
  saveGlobalMemory,
  buildMemoryPrompt,
  buildGlobalMemoryPrompt,
  createFolderMemoryStore,
  createGlobalMemoryStore,
  type SessionState,
} from "../persistence";
import type { ChatMessage } from "../apiClient";
import type { TodoItem } from "../tools/todos";

// ---- resolveContainedPath (pure) ----

const ROOT = path.resolve("/workspace");

test("resolveContainedPath allows a plain relative path", () => {
  assert.equal(resolveContainedPath(ROOT, "AGENTS.md"), path.resolve(ROOT, "AGENTS.md"));
});

test("resolveContainedPath allows nested subdirectories", () => {
  assert.equal(resolveContainedPath(ROOT, "notes/deep/facts.md"), path.resolve(ROOT, "notes/deep/facts.md"));
});

test("resolveContainedPath rejects ../ escapes", () => {
  assert.throws(() => resolveContainedPath(ROOT, "../outside.md"), /escapes the workspace/);
});

test("resolveContainedPath rejects absolute paths outside the root", () => {
  const outsideAbs = process.platform === "win32" ? "C:\\Windows\\system32" : "/etc/passwd";
  assert.throws(() => resolveContainedPath(ROOT, outsideAbs), /escapes the workspace/);
});

// ---- getSessionPath / getMemoryPath (pure) ----

test("getSessionPath joins the session dir and file under the root", () => {
  assert.equal(getSessionPath(ROOT), path.join(ROOT, SESSION_DIR, SESSION_FILE));
});

test("getMemoryPath defaults to AGENTS.md when the name is empty", () => {
  assert.equal(getMemoryPath(ROOT, ""), path.join(ROOT, DEFAULT_MEMORY_FILE));
  assert.equal(getMemoryPath(ROOT, "   "), path.join(ROOT, DEFAULT_MEMORY_FILE));
});

test("getMemoryPath uses the provided workspace-relative name", () => {
  assert.equal(getMemoryPath(ROOT, "docs/NOTES.md"), path.join(ROOT, "docs", "NOTES.md"));
});

test("getMemoryPath rejects a name that escapes the workspace", () => {
  assert.throws(() => getMemoryPath(ROOT, "../../etc/passwd"), /escapes the workspace/);
});

// ---- getGlobalMemoryPath (pure) ----

test("getGlobalMemoryPath defaults to GLOBAL_AGENTS.md when the name is empty", () => {
  assert.equal(getGlobalMemoryPath(ROOT, ""), path.join(ROOT, DEFAULT_GLOBAL_MEMORY_FILE));
  assert.equal(getGlobalMemoryPath(ROOT, "   "), path.join(ROOT, DEFAULT_GLOBAL_MEMORY_FILE));
});

test("getGlobalMemoryPath uses the provided file name within the global dir", () => {
  assert.equal(getGlobalMemoryPath(ROOT, "GLOBAL_NOTES.md"), path.join(ROOT, "GLOBAL_NOTES.md"));
});

test("getGlobalMemoryPath rejects an empty global directory", () => {
  assert.throws(() => getGlobalMemoryPath("", "GLOBAL_AGENTS.md"), /not available/i);
});

test("getGlobalMemoryPath rejects a name that escapes the global storage dir", () => {
  assert.throws(() => getGlobalMemoryPath(ROOT, "../../etc/passwd"), /escapes the storage directory/);
});

// ---- stripToPersistableHistory (pure) ----

test("stripToPersistableHistory keeps ordinary user/assistant messages", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ];
  assert.deepEqual(stripToPersistableHistory(history), history);
});

test("stripToPersistableHistory drops an orphaned tool result with no preceding tool_call", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "hi" },
    { role: "tool", tool_call_id: "x", content: "orphan" },
  ];
  assert.deepEqual(stripToPersistableHistory(history), [{ role: "user", content: "hi" }]);
});

test("stripToPersistableHistory drops a tool result following an assistant message without tool_calls", () => {
  const history: ChatMessage[] = [
    { role: "assistant", content: "no calls here" },
    { role: "tool", tool_call_id: "x", content: "orphan" },
  ];
  assert.deepEqual(stripToPersistableHistory(history), [{ role: "assistant", content: "no calls here" }]);
});

test("stripToPersistableHistory keeps a tool result paired with its preceding tool_call", () => {
  const history: ChatMessage[] = [
    { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "read_file" } }] },
    { role: "tool", tool_call_id: "1", content: "file contents" },
  ];
  assert.deepEqual(stripToPersistableHistory(history), history);
});

// ---- serializeSession / parseSession (pure) ----

function sampleSession(): SessionState {
  return {
    version: SESSION_VERSION,
    history: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi there" }],
    uiLog: [{ role: "user", text: "hello" }, { role: "assistant", text: "hi there" }],
    todoList: [{ id: "abc", content: "do something", status: "pending" }],
    selectedModel: "gpt-4",
    savedAt: 1700000000000,
  };
}

test("serializeSession produces pretty JSON containing every field", () => {
  const json = serializeSession(sampleSession());
  assert.ok(json.includes('"version"'));
  assert.ok(json.includes('"history"'));
  assert.ok(json.includes('"uiLog"'));
  assert.ok(json.includes('"todoList"'));
  assert.ok(json.includes('"selectedModel": "gpt-4"'));
  assert.ok(json.includes('"savedAt"'));
  // pretty-printed (2-space indent)
  assert.ok(json.includes('\n  "version"'));
});

test("parseSession round-trips a serialized session", () => {
  const original = sampleSession();
  const parsed = parseSession(serializeSession(original));
  assert.deepEqual(parsed, original);
});

test("parseSession returns null for empty or whitespace input", () => {
  assert.equal(parseSession(""), null);
  assert.equal(parseSession("   \n  "), null);
});

test("parseSession returns null for corrupt JSON", () => {
  assert.equal(parseSession("{not valid json"), null);
  assert.equal(parseSession("}"), null);
});

test("parseSession returns null for a non-object JSON value", () => {
  assert.equal(parseSession("[1,2,3]"), null);
  assert.equal(parseSession('"a string"'), null);
  assert.equal(parseSession("42"), null);
});

test("parseSession rejects an unknown/older session version", () => {
  const bad = serializeSession({ ...sampleSession(), version: 999 });
  assert.equal(parseSession(bad), null);
});

test("parseSession filters malformed entries and defaults missing scalar fields", () => {
  const raw = JSON.stringify({
    version: SESSION_VERSION,
    history: [{ role: "user", content: "ok" }, "not-a-message", null, { content: "no role" }],
    uiLog: [{ role: "user", text: "ok" }, { role: "user" }, { text: "no role" }],
    todoList: [{ id: "1", content: "ok", status: "pending" }, { id: "2" }, { content: "no id" }],
    // selectedModel and savedAt intentionally omitted
  });
  const parsed = parseSession(raw);
  assert.ok(parsed);
  assert.equal(parsed!.version, SESSION_VERSION);
  assert.equal(parsed!.history.length, 1);
  assert.equal(parsed!.history[0].role, "user");
  assert.equal(parsed!.uiLog.length, 1);
  assert.equal(parsed!.uiLog[0].text, "ok");
  assert.equal(parsed!.todoList.length, 1);
  assert.equal(parsed!.todoList[0].id, "1");
  assert.equal(parsed!.selectedModel, "");
  assert.equal(parsed!.savedAt, 0);
});

test("parseSession tolerates missing arrays by defaulting them to empty", () => {
  const raw = JSON.stringify({ version: SESSION_VERSION });
  const parsed = parseSession(raw);
  assert.ok(parsed);
  assert.deepEqual(parsed!.history, []);
  assert.deepEqual(parsed!.uiLog, []);
  assert.deepEqual(parsed!.todoList, []);
});

// ---- buildMemoryPrompt (pure) ----

test("buildMemoryPrompt returns empty string for blank memory", () => {
  assert.equal(buildMemoryPrompt(""), "");
  assert.equal(buildMemoryPrompt("   \n\t "), "");
});

test("buildMemoryPrompt wraps memory in an <agent_memory> block", () => {
  const block = buildMemoryPrompt("# Project\nWe use pnpm.");
  assert.ok(block.startsWith("\n\n<agent_memory>"));
  assert.ok(block.includes("</agent_memory>"));
  assert.ok(block.includes("# Project\nWe use pnpm."));
});

test("buildMemoryPrompt tells the agent to keep memory current via update_memory", () => {
  const block = buildMemoryPrompt("remember this");
  assert.ok(block.includes("update_memory"));
  assert.ok(block.toLowerCase().includes("persistent memory"));
});

test("buildMemoryPrompt truncates oversized memory and notes the truncation", () => {
  // A unique end marker ensures we can tell whether the tail survived; the
  // bulk is "x" so the content is well past the byte cap (ASCII => 1 byte/char).
  const big = "x".repeat(MAX_MEMORY_BYTES + 1000) + "ENDMARKER_SHOULD_BE_GONE";
  const block = buildMemoryPrompt(big);
  assert.ok(block.includes("[... memory truncated to fit context ...]"));
  // The unique tail (past the cap) must have been cut off.
  assert.equal(block.includes("ENDMARKER_SHOULD_BE_GONE"), false, "expected the tail of oversized memory to be truncated away");
  // The content portion (before the notice) is exactly MAX_MEMORY_BYTES chars.
  const content = block.split("\n\n[... memory truncated to fit context ...]")[0];
  const memoryBody = content.split("---\n")[1];
  assert.equal(memoryBody.length, MAX_MEMORY_BYTES);
});

// ---- buildGlobalMemoryPrompt (pure) ----

test("buildGlobalMemoryPrompt returns empty string for blank memory", () => {
  assert.equal(buildGlobalMemoryPrompt(""), "");
  assert.equal(buildGlobalMemoryPrompt("   \n\t "), "");
});

test("buildGlobalMemoryPrompt wraps memory in an <agent_global_memory> block", () => {
  const block = buildGlobalMemoryPrompt("# Global\nI prefer tabs.");
  assert.ok(block.startsWith("\n\n<agent_global_memory>"));
  assert.ok(block.includes("</agent_global_memory>"));
  assert.ok(block.includes("# Global\nI prefer tabs."));
});

test("buildGlobalMemoryPrompt is distinct from the folder-scoped block", () => {
  // The global block must NOT reuse the folder <agent_memory> wrapper.
  assert.equal(buildGlobalMemoryPrompt("x").includes("<agent_memory>"), false);
  // And the folder block must NOT use the global wrapper.
  assert.equal(buildMemoryPrompt("x").includes("<agent_global_memory>"), false);
});

test("buildGlobalMemoryPrompt tells the agent to keep memory current via update_memory with scope global", () => {
  const block = buildGlobalMemoryPrompt("remember this");
  assert.ok(block.includes("update_memory"));
  assert.ok(block.toLowerCase().includes("global"));
  assert.ok(block.toLowerCase().includes("cross-project"));
});

test("buildGlobalMemoryPrompt truncates oversized memory and notes the truncation", () => {
  const big = "x".repeat(MAX_MEMORY_BYTES + 1000) + "ENDMARKER_SHOULD_BE_GONE";
  const block = buildGlobalMemoryPrompt(big);
  assert.ok(block.includes("[... global memory truncated to fit context ...]"));
  assert.equal(block.includes("ENDMARKER_SHOULD_BE_GONE"), false, "expected the tail of oversized global memory to be truncated away");
  const content = block.split("\n\n[... global memory truncated to fit context ...]")[0];
  const memoryBody = content.split("---\n")[1];
  assert.equal(memoryBody.length, MAX_MEMORY_BYTES);
});

// ---- fs wrappers (real temp directory on disk) ----

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-agent-chat-persist-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("saveSession writes the snapshot under .ai-agent-chat/session.json and loadSession reads it back", () => {
  const ok = saveSession(tmpDir, sampleSession());
  assert.equal(ok, true);
  assert.ok(fs.existsSync(getSessionPath(tmpDir)));
  const loaded = loadSession(tmpDir);
  assert.deepEqual(loaded, sampleSession());
});

test("loadSession returns null when no session file exists", () => {
  assert.equal(loadSession(tmpDir), null);
});

test("loadSession returns null when the session file is corrupt", () => {
  fs.mkdirSync(path.join(tmpDir, SESSION_DIR), { recursive: true });
  fs.writeFileSync(getSessionPath(tmpDir), "{ broken", "utf8");
  assert.equal(loadSession(tmpDir), null);
});

test("clearSession removes an existing session file and is a no-op when absent", () => {
  saveSession(tmpDir, sampleSession());
  assert.ok(fs.existsSync(getSessionPath(tmpDir)));
  clearSession(tmpDir);
  assert.equal(fs.existsSync(getSessionPath(tmpDir)), false);
  // second call must not throw
  clearSession(tmpDir);
});

test("saveMemory writes the memory file and loadMemory reads it back", () => {
  const ok = saveMemory(tmpDir, "AGENTS.md", "# Notes\nuse pnpm.");
  assert.equal(ok, true);
  assert.equal(fs.readFileSync(getMemoryPath(tmpDir, "AGENTS.md"), "utf8"), "# Notes\nuse pnpm.");
  assert.equal(loadMemory(tmpDir, "AGENTS.md"), "# Notes\nuse pnpm.");
});

test("loadMemory returns an empty string when the memory file is absent", () => {
  assert.equal(loadMemory(tmpDir, "AGENTS.md"), "");
});

test("saveMemory creates parent directories for a nested memory path", () => {
  const ok = saveMemory(tmpDir, "docs/notes/AGENTS.md", "deep notes");
  assert.equal(ok, true);
  assert.equal(loadMemory(tmpDir, "docs/notes/AGENTS.md"), "deep notes");
});

test("saveMemory truncates content that exceeds the memory byte cap", () => {
  const big = "y".repeat(MAX_MEMORY_BYTES + 500);
  saveMemory(tmpDir, "AGENTS.md", big);
  const onDisk = fs.readFileSync(getMemoryPath(tmpDir, "AGENTS.md"), "utf8");
  assert.equal(onDisk.length, MAX_MEMORY_BYTES);
});

// ---- loadGlobalMemory / saveGlobalMemory (real temp directory on disk) ----

test("saveGlobalMemory writes the global memory file and loadGlobalMemory reads it back", () => {
  const ok = saveGlobalMemory(tmpDir, "GLOBAL_AGENTS.md", "# Global\nI prefer tabs.");
  assert.equal(ok, true);
  assert.equal(fs.readFileSync(getGlobalMemoryPath(tmpDir, "GLOBAL_AGENTS.md"), "utf8"), "# Global\nI prefer tabs.");
  assert.equal(loadGlobalMemory(tmpDir, "GLOBAL_AGENTS.md"), "# Global\nI prefer tabs.");
});

test("loadGlobalMemory returns an empty string when the global memory file is absent", () => {
  assert.equal(loadGlobalMemory(tmpDir, "GLOBAL_AGENTS.md"), "");
});

test("saveGlobalMemory creates the storage directory when it does not exist", () => {
  const nested = path.join(tmpDir, "does", "not", "exist");
  const ok = saveGlobalMemory(nested, "GLOBAL_AGENTS.md", "deep global notes");
  assert.equal(ok, true);
  assert.equal(loadGlobalMemory(nested, "GLOBAL_AGENTS.md"), "deep global notes");
});

test("saveGlobalMemory truncates content that exceeds the memory byte cap", () => {
  const big = "z".repeat(MAX_MEMORY_BYTES + 500);
  saveGlobalMemory(tmpDir, "GLOBAL_AGENTS.md", big);
  const onDisk = fs.readFileSync(getGlobalMemoryPath(tmpDir, "GLOBAL_AGENTS.md"), "utf8");
  assert.equal(onDisk.length, MAX_MEMORY_BYTES);
});

test("global memory lives independently from folder memory (no shared file)", () => {
  // Folder memory goes into the workspace root, global into the storage dir.
  saveMemory(tmpDir, "AGENTS.md", "folder note");
  const globalDir = path.join(tmpDir, "global");
  saveGlobalMemory(globalDir, "GLOBAL_AGENTS.md", "global note");
  assert.equal(loadMemory(tmpDir, "AGENTS.md"), "folder note");
  assert.equal(loadGlobalMemory(globalDir, "GLOBAL_AGENTS.md"), "global note");
  // Neither file was clobbered by the other.
  assert.equal(fs.existsSync(getMemoryPath(tmpDir, "AGENTS.md")), true);
  assert.equal(fs.existsSync(getGlobalMemoryPath(globalDir, "GLOBAL_AGENTS.md")), true);
});

// ---- createFolderMemoryStore / createGlobalMemoryStore (disk = source of truth) ----
//
// These stores back the getMemory/setMemory + getGlobalMemory/setGlobalMemory
// ToolContext hooks. The defining invariant they restore (and that a prior bug
// broke): reads ALWAYS hit disk, so an external write to the memory file — a
// manual edit, /init writing AGENTS.md via write_file, etc. — is reflected on
// the next get(), instead of being masked by a value cached once at startup.

test("createFolderMemoryStore.get reads from disk (returns \"\" when the file is absent)", () => {
  const store = createFolderMemoryStore(tmpDir, () => "AGENTS.md");
  assert.equal(store.get(), "");
});

test("createFolderMemoryStore.set writes the file and get reads it back", () => {
  const store = createFolderMemoryStore(tmpDir, () => "AGENTS.md");
  store.set("# Notes\nuse pnpm.");
  assert.equal(store.get(), "# Notes\nuse pnpm.");
  assert.equal(fs.readFileSync(getMemoryPath(tmpDir, "AGENTS.md"), "utf8"), "# Notes\nuse pnpm.");
});

test("createFolderMemoryStore.get reflects an EXTERNAL write to the file (no cached snapshot)", () => {
  // This is the regression test for the /config 0-bytes bug: the file is
  // written by a path other than set(), and the store must see it.
  const store = createFolderMemoryStore(tmpDir, () => "AGENTS.md");
  assert.equal(store.get(), "");
  fs.writeFileSync(getMemoryPath(tmpDir, "AGENTS.md"), "# Written externally by /init", "utf8");
  assert.equal(store.get(), "# Written externally by /init");
  // A subsequent external edit is also picked up — proving there is no cache.
  fs.writeFileSync(getMemoryPath(tmpDir, "AGENTS.md"), "# Edited again", "utf8");
  assert.equal(store.get(), "# Edited again");
});

test("createFolderMemoryStore honors a getMemoryFile that changes over time (no fixed path)", () => {
  let name = "AGENTS.md";
  const store = createFolderMemoryStore(tmpDir, () => name);
  store.set("folder notes");
  assert.equal(store.get(), "folder notes");
  // Switching the configured memory file name targets a different file on disk.
  name = "NOTES.md";
  assert.equal(store.get(), "");
  store.set("alt notes");
  assert.equal(store.get(), "alt notes");
  // The original file is untouched.
  name = "AGENTS.md";
  assert.equal(store.get(), "folder notes");
});

test("createFolderMemoryStore.get returns \"\" after the file is deleted externally", () => {
  const store = createFolderMemoryStore(tmpDir, () => "AGENTS.md");
  store.set("temporary notes");
  assert.equal(store.get(), "temporary notes");
  fs.unlinkSync(getMemoryPath(tmpDir, "AGENTS.md"));
  assert.equal(store.get(), "");
});

test("createGlobalMemoryStore.get reads from disk (returns \"\" when the file is absent)", () => {
  const globalDir = path.join(tmpDir, "global-storage");
  const store = createGlobalMemoryStore(globalDir, () => "GLOBAL_AGENTS.md");
  assert.equal(store.get(), "");
});

test("createGlobalMemoryStore.set writes the file and get reads it back", () => {
  const globalDir = path.join(tmpDir, "global-storage");
  const store = createGlobalMemoryStore(globalDir, () => "GLOBAL_AGENTS.md");
  store.set("# Global\nI prefer tabs.");
  assert.equal(store.get(), "# Global\nI prefer tabs.");
  assert.equal(fs.readFileSync(getGlobalMemoryPath(globalDir, "GLOBAL_AGENTS.md"), "utf8"), "# Global\nI prefer tabs.");
});

test("createGlobalMemoryStore.get reflects an EXTERNAL write to the file (no cached snapshot)", () => {
  const globalDir = path.join(tmpDir, "global-storage");
  // The global storage directory exists in real usage (globalStorageUri), so
  // create it here before the external write (a raw fs.writeFileSync does not
  // mkdir parents, unlike saveGlobalMemory).
  fs.mkdirSync(globalDir, { recursive: true });
  const store = createGlobalMemoryStore(globalDir, () => "GLOBAL_AGENTS.md");
  assert.equal(store.get(), "");
  fs.writeFileSync(getGlobalMemoryPath(globalDir, "GLOBAL_AGENTS.md"), "# Global written externally", "utf8");
  assert.equal(store.get(), "# Global written externally");
});

test("createGlobalMemoryStore with an empty directory is a no-op store (get \"\" + set is silent)", () => {
  // Models the no-global-storage-dir branch: globalMemoryDir === "".
  const store = createGlobalMemoryStore("", () => "GLOBAL_AGENTS.md");
  assert.equal(store.get(), "");
  assert.doesNotThrow(() => store.set("anything"));
  assert.equal(store.get(), "");
});

test("the folder and global stores target different files and do not clobber each other", () => {
  const folderStore = createFolderMemoryStore(tmpDir, () => "AGENTS.md");
  const globalDir = path.join(tmpDir, "global");
  const globalStore = createGlobalMemoryStore(globalDir, () => "GLOBAL_AGENTS.md");
  folderStore.set("folder note");
  globalStore.set("global note");
  assert.equal(folderStore.get(), "folder note");
  assert.equal(globalStore.get(), "global note");
  assert.equal(fs.existsSync(getMemoryPath(tmpDir, "AGENTS.md")), true);
  assert.equal(fs.existsSync(getGlobalMemoryPath(globalDir, "GLOBAL_AGENTS.md")), true);
});

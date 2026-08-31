/**
 * Regression tests for the two context-preservation mechanisms:
 *
 *  1. Per-Tool Truncation Budget — tools.ts#truncateToolOutput caps the raw
 *     output of data-heavy tools (read_file, list_directory, find_files,
 *     git_diff) at ~12k chars and appends a notice pointing the agent at
 *     finer-grained tools.
 *  2. Semantic Sliding Window — agent.ts#applySemanticSlidingWindow keeps the
 *     system prompt (index 0) and the most recent 8 messages intact, and
 *     replaces the body of any OLDER `role === "tool"` message whose content is
 *     massive with a compression placeholder, preserving the message envelope
 *     (role + tool_call_id) so it still pairs with its preceding tool_call.
 *
 * The pure helpers are unit-tested directly; the tool integration cases
 * (read_file / list_directory / find_files / git_diff actually truncating)
 * exercise the real executeTool against a temp workspace via the vscode stub.
 */
import * as assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  executeTool,
  truncateToolOutput,
  MAX_TOOL_OUTPUT_CHARS,
} from "../tools";
import {
  applySemanticSlidingWindow,
  RECENT_WINDOW_MESSAGES,
  TOOL_COMPRESS_THRESHOLD,
  COMPRESSED_TOOL_NOTICE,
} from "../agent";
import type { ChatMessage } from "../apiClient";

// Untyped: resolves to test/vscode-stub.js (see test/register-vscode-stub.js).
const vscode: any = require("vscode");

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-agent-chat-ctx-"));
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: tmpDir } }];
  vscode.__confirm = undefined;
  vscode.__terminalSendTextCalls = [];
  vscode.__diagnosticsMap = new Map();
  vscode.window.activeTextEditor = undefined;
});

afterEach(() => {
  vscode.workspace.workspaceFolders = undefined;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Per-Tool Truncation Budget — pure helper
// ---------------------------------------------------------------------------

test("truncateToolOutput leaves short output unchanged", () => {
  assert.equal(truncateToolOutput("hello"), "hello");
  assert.equal(truncateToolOutput(""), "");
});

test("truncateToolOutput leaves output at exactly the budget unchanged", () => {
  const exact = "x".repeat(MAX_TOOL_OUTPUT_CHARS);
  assert.equal(truncateToolOutput(exact), exact);
  assert.equal(truncateToolOutput(exact).length, MAX_TOOL_OUTPUT_CHARS);
});

test("truncateToolOutput slices output just over the budget and appends the notice", () => {
  const over = "x".repeat(MAX_TOOL_OUTPUT_CHARS + 1);
  const result = truncateToolOutput(over);
  assert.ok(result.startsWith("x".repeat(MAX_TOOL_OUTPUT_CHARS)), "first 12k chars preserved");
  assert.ok(result.endsWith("specific sections.]"), "truncation notice appended");
  assert.ok(result.includes("truncated at 12k chars"), "notice mentions the budget");
  assert.ok(result.includes("read_file_lines"), "notice points at read_file_lines");
  // The kept prefix is exactly the budget; the rest is the appended notice.
  assert.equal(result.indexOf("x".repeat(MAX_TOOL_OUTPUT_CHARS)), 0);
  assert.ok(result.length > MAX_TOOL_OUTPUT_CHARS, "notice adds length beyond the budget");
});

test("truncateToolOutput honors a custom maxChars budget", () => {
  const result = truncateToolOutput("abcdefghij", 4);
  assert.equal(result.length, 4 + "\n... [Output truncated at 12k chars. Use read_file_lines or targeted search to view specific sections.]".length);
  assert.ok(result.startsWith("abcd"));
  assert.ok(result.endsWith("specific sections.]"));
});

test("truncateToolOutput is a pure function and does not mutate the input", () => {
  const input = "y".repeat(MAX_TOOL_OUTPUT_CHARS + 50);
  const snapshot = input;
  truncateToolOutput(input);
  assert.equal(input, snapshot, "input string must not be mutated");
});

// ---------------------------------------------------------------------------
// Per-Tool Truncation Budget — integration through executeTool
// ---------------------------------------------------------------------------

test("read_file truncates a file larger than the budget and appends the notice", async () => {
  const big = "LINE\n".repeat(4000); // 20k chars > 12k budget
  fs.writeFileSync(path.join(tmpDir, "big.txt"), big, "utf8");
  const result = await executeTool("read_file", { path: "big.txt" });
  assert.ok(result.length < big.length, "truncated output is shorter than the file");
  assert.ok(result.endsWith("specific sections.]"), "truncation notice appended");
  assert.ok(result.includes("truncated at 12k chars"), "notice mentions the budget");
  // The first MAX_TOOL_OUTPUT_CHARS chars of the file must be preserved verbatim.
  assert.equal(result.indexOf(big.slice(0, MAX_TOOL_OUTPUT_CHARS)), 0);
});

test("read_file leaves a small file untouched (no truncation notice)", async () => {
  fs.writeFileSync(path.join(tmpDir, "small.txt"), "just a few lines\n", "utf8");
  const result = await executeTool("read_file", { path: "small.txt" });
  assert.equal(result, "just a few lines\n");
  assert.equal(result.includes("truncated"), false);
});

test("list_directory truncates a directory listing larger than the budget", async () => {
  // Create enough entries that the joined listing exceeds 12k chars.
  const count = 4000;
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(tmpDir, `entry-${i.toString().padStart(5, "0")}.txt`), "", "utf8");
  }
  const result = await executeTool("list_directory", {});
  assert.ok(result.length > MAX_TOOL_OUTPUT_CHARS, "raw listing would exceed the budget");
  // After truncation the result is the 12k prefix + notice, so it grows beyond 12k
  // but the payload portion is capped.
  assert.ok(result.endsWith("specific sections.]"), "truncation notice appended");
  assert.ok(result.includes("truncated at 12k chars"), "notice mentions the budget");
});

test("find_files truncates a result set larger than the budget", async () => {
  const count = 4000;
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(tmpDir, `file-${i.toString().padStart(5, "0")}.ts`), "", "utf8");
  }
  const result = await executeTool("find_files", { glob: "**/*.ts" });
  assert.ok(result.endsWith("specific sections.]"), "truncation notice appended");
  assert.ok(result.includes("truncated at 12k chars"), "notice mentions the budget");
  // Confirm the prefix is real file paths (not already truncated on the first call).
  assert.match(result.slice(0, 40), /^file-\d+\.ts/);
});

test("git_diff truncates a diff larger than the budget", async (t) => {
  // git_diff shells out to real git; skip the test gracefully if git isn't on PATH.
  try {
    cp.execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("git not available on PATH");
    return;
  }
  // Initialize a repo with a baseline commit, then make a large unstaged change
  // so `git diff` (the default with no args) produces more than 12k chars.
  cp.execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
  cp.execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tmpDir, stdio: "ignore" });
  cp.execFileSync("git", ["config", "user.name", "Test"], { cwd: tmpDir, stdio: "ignore" });
  const baseline = path.join(tmpDir, "big.txt");
  fs.writeFileSync(baseline, "line\n", "utf8");
  cp.execFileSync("git", ["add", "big.txt"], { cwd: tmpDir, stdio: "ignore" });
  cp.execFileSync("git", ["commit", "-m", "baseline"], { cwd: tmpDir, stdio: "ignore" });
  // Overwrite with enough added content to exceed the 12k char budget.
  fs.writeFileSync(baseline, "X".repeat(MAX_TOOL_OUTPUT_CHARS + 2000) + "\n", "utf8");
  const result = await executeTool("git_diff", {});
  assert.ok(result.length > MAX_TOOL_OUTPUT_CHARS, "raw diff would exceed the budget");
  assert.ok(result.endsWith("specific sections.]"), "truncation notice appended");
  assert.ok(result.includes("truncated at 12k chars"), "notice mentions the budget");
  // Confirm the prefix is a real diff header, not already truncated on the first call.
  assert.match(result.slice(0, 40), /^diff --git/);
});

// ---------------------------------------------------------------------------
// Semantic Sliding Window — pure helper
// ---------------------------------------------------------------------------

/** Build a history where tool messages carry an explicit size marker. */
function buildHistory(opts: { total: number; massiveFromIndex?: number }): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: "system", content: "system prompt" }];
  for (let i = 1; i < opts.total; i++) {
    // Alternate assistant (with tool_calls) and tool results to keep pairs valid.
    if (i % 2 === 1) {
      msgs.push({
        role: "assistant",
        content: `assistant ${i}`,
        tool_calls: [{ id: `call-${i}`, type: "function", function: { name: "read_file", arguments: "{}" } }],
      });
    } else {
      const massive = opts.massiveFromIndex !== undefined && i >= opts.massiveFromIndex;
      const content = massive ? "X".repeat(TOOL_COMPRESS_THRESHOLD + 500) : `small tool result ${i}`;
      msgs.push({ role: "tool", tool_call_id: `call-${i - 1}`, content });
    }
  }
  return msgs;
}

test("applySemanticSlidingWindow returns a new array and never mutates the input", () => {
  const history = buildHistory({ total: 20, massiveFromIndex: 2 });
  const snapshot = history.map((m) => ({ ...m }));
  const view = applySemanticSlidingWindow(history);
  assert.notEqual(view, history, "must return a new array");
  assert.deepEqual(history, snapshot, "input array and its messages must be unchanged");
});

test("applySemanticSlidingWindow keeps index 0 (system prompt) intact", () => {
  const history = buildHistory({ total: 30, massiveFromIndex: 2 });
  const view = applySemanticSlidingWindow(history);
  assert.equal(view[0].role, "system");
  assert.equal(view[0].content, "system prompt");
});

test("applySemanticSlidingWindow keeps the most recent RECENT_WINDOW_MESSAGES intact", () => {
  const history = buildHistory({ total: 30, massiveFromIndex: 2 });
  const view = applySemanticSlidingWindow(history);
  const n = history.length;
  for (let i = n - RECENT_WINDOW_MESSAGES; i < n; i++) {
    assert.deepEqual(view[i], history[i], `recent message ${i} must be intact`);
  }
});

test("applySemanticSlidingWindow compresses an OLD massive tool result but preserves its envelope", () => {
  const history = buildHistory({ total: 30, massiveFromIndex: 2 });
  const view = applySemanticSlidingWindow(history);
  const n = history.length;
  const protectedStart = Math.max(1, n - RECENT_WINDOW_MESSAGES);
  // Find an old tool message (index < protectedStart) that was massive.
  let checked = 0;
  for (let i = 1; i < protectedStart; i++) {
    if (history[i].role === "tool" && (history[i].content ?? "").length > TOOL_COMPRESS_THRESHOLD) {
      checked++;
      assert.equal(view[i].role, "tool", `role preserved at ${i}`);
      assert.equal(view[i].tool_call_id, history[i].tool_call_id, `tool_call_id preserved at ${i}`);
      assert.equal(view[i].content, COMPRESSED_TOOL_NOTICE, `body compressed at ${i}`);
    }
  }
  assert.ok(checked > 0, "expected at least one old massive tool message to compress");
});

test("applySemanticSlidingWindow leaves a SMALL old tool result intact (audit trail)", () => {
  // No massive messages at all.
  const history = buildHistory({ total: 30 });
  const view = applySemanticSlidingWindow(history);
  const n = history.length;
  const protectedStart = Math.max(1, n - RECENT_WINDOW_MESSAGES);
  for (let i = 1; i < protectedStart; i++) {
    if (history[i].role === "tool") {
      assert.deepEqual(view[i], history[i], `small old tool result ${i} must be intact`);
      assert.notEqual(view[i].content, COMPRESSED_TOOL_NOTICE, "small result must not be compressed");
    }
  }
});

test("applySemanticSlidingWindow does not touch old assistant/user messages", () => {
  const history = buildHistory({ total: 30, massiveFromIndex: 2 });
  const view = applySemanticSlidingWindow(history);
  const n = history.length;
  const protectedStart = Math.max(1, n - RECENT_WINDOW_MESSAGES);
  for (let i = 1; i < protectedStart; i++) {
    if (history[i].role !== "tool") {
      assert.deepEqual(view[i], history[i], `non-tool message ${i} must be intact`);
    }
  }
});

test("applySemanticSlidingWindow leaves a short history unchanged (nothing old enough to compress)", () => {
  // History shorter than the recent window: everything is protected.
  const history = buildHistory({ total: 5, massiveFromIndex: 2 });
  const view = applySemanticSlidingWindow(history);
  assert.deepEqual(view, history);
});

test("applySemanticSlidingWindow with only a system prompt returns it untouched", () => {
  const history: ChatMessage[] = [{ role: "system", content: "sys" }];
  const view = applySemanticSlidingWindow(history);
  assert.deepEqual(view, history);
});

test("applySemanticSlidingWindow honors custom recentWindow and compressThreshold", () => {
  const history = buildHistory({ total: 12 });
  // Force the threshold low so the "small" tool results now qualify, and shrink
  // the recent window so more messages become eligible.
  const view = applySemanticSlidingWindow(history, { recentWindow: 2, compressThreshold: 5 });
  const n = history.length;
  const protectedStart = Math.max(1, n - 2);
  for (let i = 1; i < protectedStart; i++) {
    if (history[i].role === "tool" && typeof history[i].content === "string") {
      assert.equal(view[i].content, COMPRESSED_TOOL_NOTICE, `tool ${i} compressed under low threshold`);
    }
  }
  // The last 2 are still intact.
  for (let i = n - 2; i < n; i++) {
    assert.deepEqual(view[i], history[i], `recent message ${i} intact`);
  }
});

test("a tool result exactly at the threshold is NOT compressed (strictly greater-than)", () => {
  const history: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "assistant", content: "a1", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "X".repeat(TOOL_COMPRESS_THRESHOLD) },
    // pad the recent window so the threshold message is in the "old" region
    ...Array.from({ length: RECENT_WINDOW_MESSAGES + 1 }, (_, k) => ({
      role: "user" as const,
      content: `u${k}`,
    })),
  ];
  const view = applySemanticSlidingWindow(history);
  const toolIdx = 2;
  assert.ok(toolIdx < history.length - RECENT_WINDOW_MESSAGES, "tool message is in the old region");
  assert.equal(view[toolIdx].content, "X".repeat(TOOL_COMPRESS_THRESHOLD), "exactly-at-threshold is not compressed");
});

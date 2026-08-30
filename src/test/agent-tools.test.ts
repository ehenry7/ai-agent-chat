import * as assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { executeTool } from "../tools";

// Untyped: this resolves to test/vscode-stub.js at runtime (see
// test/register-vscode-stub.js), which exposes test-only hooks like
// workspaceFolders/__confirm that aren't part of the real @types/vscode.
const vscode: any = require("vscode");

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-agent-chat-test-"));
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: tmpDir } }];
  vscode.__confirm = undefined;
});

afterEach(() => {
  vscode.workspace.workspaceFolders = undefined;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("write_file creates a new file with the given content on disk", async () => {
  const result = await executeTool("write_file", { path: "hello.txt", content: "hello world" });
  assert.match(result, /Wrote \d+ bytes to hello\.txt/);
  assert.equal(fs.readFileSync(path.join(tmpDir, "hello.txt"), "utf8"), "hello world");
});

test("read_file returns the actual content written to disk", async () => {
  fs.writeFileSync(path.join(tmpDir, "existing.txt"), "on-disk content", "utf8");
  const result = await executeTool("read_file", { path: "existing.txt" });
  assert.equal(result, "on-disk content");
});

test("write_file then read_file round-trips the same content", async () => {
  await executeTool("write_file", { path: "roundtrip.txt", content: "round trip data" });
  const result = await executeTool("read_file", { path: "roundtrip.txt" });
  assert.equal(result, "round trip data");
});

test("create_directory makes a real directory on disk", async () => {
  const result = await executeTool("create_directory", { path: "sub/nested" });
  assert.match(result, /Created directory sub\/nested/);
  assert.ok(fs.statSync(path.join(tmpDir, "sub", "nested")).isDirectory());
});

test("list_directory reflects real files and subdirectories on disk", async () => {
  fs.writeFileSync(path.join(tmpDir, "a.txt"), "a", "utf8");
  fs.mkdirSync(path.join(tmpDir, "b-dir"));
  const result = await executeTool("list_directory", {});
  const entries = result.split("\n");
  assert.ok(entries.includes("a.txt"));
  assert.ok(entries.includes("b-dir/"));
});

test("rename_file actually moves the file on disk", async () => {
  fs.writeFileSync(path.join(tmpDir, "old-name.txt"), "content", "utf8");
  const result = await executeTool("rename_file", { oldPath: "old-name.txt", newPath: "new-name.txt" });
  assert.match(result, /Renamed old-name\.txt -> new-name\.txt/);
  assert.equal(fs.existsSync(path.join(tmpDir, "old-name.txt")), false);
  assert.equal(fs.readFileSync(path.join(tmpDir, "new-name.txt"), "utf8"), "content");
});

test("delete_file removes the file on disk when the user confirms", async () => {
  fs.writeFileSync(path.join(tmpDir, "to-delete.txt"), "bye", "utf8");
  vscode.__confirm = "Delete";
  const result = await executeTool("delete_file", { path: "to-delete.txt" });
  assert.match(result, /Deleted to-delete\.txt/);
  assert.equal(fs.existsSync(path.join(tmpDir, "to-delete.txt")), false);
});

test("delete_file leaves the file untouched when the user cancels", async () => {
  fs.writeFileSync(path.join(tmpDir, "keep-me.txt"), "still here", "utf8");
  vscode.__confirm = undefined; // simulate dismissing the confirmation dialog
  const result = await executeTool("delete_file", { path: "keep-me.txt" });
  assert.equal(result, "Delete cancelled by user.");
  assert.equal(fs.existsSync(path.join(tmpDir, "keep-me.txt")), true);
});

test("write_file rejects a path that escapes the workspace", async () => {
  const result = await executeTool("write_file", { path: "../outside.txt", content: "nope" });
  assert.match(result, /Error:.*escapes the workspace/);
  assert.equal(fs.existsSync(path.join(tmpDir, "..", "outside.txt")), false);
});

test("read_file reports an error for a missing file instead of throwing", async () => {
  const result = await executeTool("read_file", { path: "does-not-exist.txt" });
  assert.match(result, /Error:/);
});

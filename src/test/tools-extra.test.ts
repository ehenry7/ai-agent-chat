import * as assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { executeTool, buildGitDiffArgs, formatSymbols, applyTextEdits } from "../tools";

const vscode: any = require("vscode");

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-agent-chat-test-"));
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: tmpDir } }];
  vscode.__confirm = undefined;
  vscode.__executeCommandImpl = undefined;
  vscode.__terminalSendTextCalls = [];
  vscode.__diagnosticsMap = new Map();
  vscode.window.activeTextEditor = undefined;
});

afterEach(() => {
  vscode.workspace.workspaceFolders = undefined;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---- edit_file ----

test("edit_file replaces a unique match without rewriting the whole file", async () => {
  fs.writeFileSync(path.join(tmpDir, "a.txt"), "hello world\nfoo bar\n", "utf8");
  const result = await executeTool("edit_file", { path: "a.txt", search: "foo bar", replace: "baz qux" });
  assert.match(result, /Edited a\.txt \(1 replacement/);
  assert.equal(fs.readFileSync(path.join(tmpDir, "a.txt"), "utf8"), "hello world\nbaz qux\n");
});

test("edit_file errors when search text is not found", async () => {
  fs.writeFileSync(path.join(tmpDir, "a.txt"), "hello world\n", "utf8");
  const result = await executeTool("edit_file", { path: "a.txt", search: "missing", replace: "x" });
  assert.match(result, /not found/);
});

test("edit_file errors on ambiguous matches unless replaceAll is set", async () => {
  fs.writeFileSync(path.join(tmpDir, "a.txt"), "dup\ndup\ndup\n", "utf8");
  const result = await executeTool("edit_file", { path: "a.txt", search: "dup", replace: "x" });
  assert.match(result, /matches 3 locations/);
  assert.equal(fs.readFileSync(path.join(tmpDir, "a.txt"), "utf8"), "dup\ndup\ndup\n");
});

test("edit_file replaceAll replaces every occurrence", async () => {
  fs.writeFileSync(path.join(tmpDir, "a.txt"), "dup\ndup\ndup\n", "utf8");
  const result = await executeTool("edit_file", { path: "a.txt", search: "dup", replace: "x", replaceAll: true });
  assert.match(result, /3 replacement/);
  assert.equal(fs.readFileSync(path.join(tmpDir, "a.txt"), "utf8"), "x\nx\nx\n");
});

// ---- edit_file: line-ending normalization ----

test("edit_file matches a multi-line search in a CRLF file when the search uses LF", async () => {
  fs.writeFileSync(path.join(tmpDir, "crlf.txt"), "alpha\r\nbeta\r\ngamma\r\n", "utf8");
  const result = await executeTool("edit_file", {
    path: "crlf.txt",
    search: "beta\ngamma",
    replace: "BETA\nGAMMA",
  });
  assert.match(result, /Edited crlf\.txt \(1 replacement/);
  assert.equal(fs.readFileSync(path.join(tmpDir, "crlf.txt"), "utf8"), "alpha\r\nBETA\r\nGAMMA\r\n");
});

test("edit_file normalizes the replacement to the file's line ending (CRLF)", async () => {
  fs.writeFileSync(path.join(tmpDir, "crlf2.txt"), "keep\r\nold\r\nkeep\r\n", "utf8");
  const result = await executeTool("edit_file", {
    path: "crlf2.txt",
    search: "old",
    replace: "new\nline",
  });
  assert.match(result, /Edited crlf2\.txt/);
  assert.equal(fs.readFileSync(path.join(tmpDir, "crlf2.txt"), "utf8"), "keep\r\nnew\r\nline\r\nkeep\r\n");
});

test("edit_file matches a multi-line search in an LF file when the search uses CRLF", async () => {
  fs.writeFileSync(path.join(tmpDir, "lf.txt"), "alpha\nbeta\ngamma\n", "utf8");
  const result = await executeTool("edit_file", {
    path: "lf.txt",
    search: "beta\r\ngamma",
    replace: "BETA\r\nGAMMA",
  });
  assert.match(result, /Edited lf\.txt \(1 replacement/);
  assert.equal(fs.readFileSync(path.join(tmpDir, "lf.txt"), "utf8"), "alpha\nBETA\nGAMMA\n");
});
// ---- find_files ----

test("find_files discovers real files matching a glob", async () => {
  fs.writeFileSync(path.join(tmpDir, "a.ts"), "", "utf8");
  fs.writeFileSync(path.join(tmpDir, "b.js"), "", "utf8");
  fs.mkdirSync(path.join(tmpDir, "sub"));
  fs.writeFileSync(path.join(tmpDir, "sub", "c.ts"), "", "utf8");
  const result = await executeTool("find_files", { glob: "**/*.ts" });
  const files = result.split("\n").sort();
  assert.deepEqual(files, ["a.ts", "sub/c.ts"]);
});

test("find_files excludes node_modules by default", async () => {
  fs.writeFileSync(path.join(tmpDir, "a.ts"), "", "utf8");
  fs.mkdirSync(path.join(tmpDir, "node_modules"));
  fs.writeFileSync(path.join(tmpDir, "node_modules", "dep.ts"), "", "utf8");
  const result = await executeTool("find_files", { glob: "**/*.ts" });
  assert.equal(result, "a.ts");
});

// ---- get_diagnostics ----

test("get_diagnostics formats file-scoped diagnostics with line numbers", async () => {
  const abs = path.join(tmpDir, "broken.ts");
  fs.writeFileSync(abs, "const x =\n", "utf8");
  vscode.__diagnosticsMap.set(abs, [
    { message: "Unexpected end of input", severity: 0, range: { start: { line: 1 } } },
  ]);
  const result = await executeTool("get_diagnostics", { path: "broken.ts" });
  assert.equal(result, "broken.ts:2: Error: Unexpected end of input");
});

test("get_diagnostics returns a friendly message when there are none", async () => {
  const abs = path.join(tmpDir, "clean.ts");
  fs.writeFileSync(abs, "const x = 1;\n", "utf8");
  const result = await executeTool("get_diagnostics", { path: "clean.ts" });
  assert.equal(result, "No diagnostics found");
});

// ---- get_active_editor ----

test("get_active_editor reports path, selection range, and selected text", async () => {
  const abs = path.join(tmpDir, "open.ts");
  fs.writeFileSync(abs, "line1\nline2\nline3\n", "utf8");
  vscode.window.activeTextEditor = {
    document: { uri: { fsPath: abs }, getText: () => "line2" },
    selection: { start: { line: 1 }, end: { line: 1 }, isEmpty: false },
  };
  const result = await executeTool("get_active_editor", {});
  assert.match(result, /Path: open\.ts/);
  assert.match(result, /Selection lines: 2-2/);
  assert.match(result, /Selected text:\nline2/);
});

test("get_active_editor reports when there is no active editor", async () => {
  vscode.window.activeTextEditor = undefined;
  const result = await executeTool("get_active_editor", {});
  assert.equal(result, "No active editor.");
});

// ---- read_file_lines ----

test("read_file_lines returns only the requested line range with line numbers", async () => {
  fs.writeFileSync(path.join(tmpDir, "lines.txt"), "a\nb\nc\nd\ne\n", "utf8");
  const result = await executeTool("read_file_lines", { path: "lines.txt", startLine: 2, endLine: 4 });
  assert.equal(result, "2: b\n3: c\n4: d");
});

test("read_file_lines defaults to the whole file when no range is given", async () => {
  fs.writeFileSync(path.join(tmpDir, "lines.txt"), "a\nb\n", "utf8");
  const result = await executeTool("read_file_lines", { path: "lines.txt" });
  assert.equal(result, "1: a\n2: b\n3: ");
});

// ---- get_symbols (pure formatting + integration via stubbed executeCommand) ----

test("formatSymbols renders a nested symbol tree with 1-based line numbers", () => {
  const symbols = [
    { name: "MyClass", kind: 4, range: { start: { line: 0 } }, children: [
      { name: "myMethod", kind: 5, range: { start: { line: 1 } }, children: [] },
    ] },
  ];
  const result = formatSymbols(symbols);
  assert.equal(result, "MyClass (Class) L1\n  myMethod (Method) L2");
});

test("get_symbols uses the document symbol provider and formats the result", async () => {
  const abs = path.join(tmpDir, "sym.ts");
  fs.writeFileSync(abs, "function foo() {}\n", "utf8");
  vscode.__executeCommandImpl = (cmd: string) => {
    assert.equal(cmd, "vscode.executeDocumentSymbolProvider");
    return [{ name: "foo", kind: 11, range: { start: { line: 0 } }, children: [] }];
  };
  const result = await executeTool("get_symbols", { path: "sym.ts" });
  assert.equal(result, "foo (Function) L1");
});

test("get_symbols reports when no symbols are found", async () => {
  const abs = path.join(tmpDir, "empty.ts");
  fs.writeFileSync(abs, "", "utf8");
  vscode.__executeCommandImpl = () => [];
  const result = await executeTool("get_symbols", { path: "empty.ts" });
  assert.equal(result, "No symbols found");
});

// ---- git_diff staged/ref (pure arg builder) ----

test("buildGitDiffArgs builds a plain diff by default", () => {
  assert.deepEqual(buildGitDiffArgs({}), ["diff"]);
});

test("buildGitDiffArgs adds --cached for staged diffs", () => {
  assert.deepEqual(buildGitDiffArgs({ staged: true }), ["diff", "--cached"]);
});

test("buildGitDiffArgs adds a ref and a path scope", () => {
  assert.deepEqual(
    buildGitDiffArgs({ ref: "HEAD~1", path: "src/agent.ts" }),
    ["diff", "HEAD~1", "--", "src/agent.ts"]
  );
});

// ---- format_document ----

test("applyTextEdits applies a single edit at the correct offset", () => {
  const text = "line1\nline2\nline3";
  const result = applyTextEdits(text, [
    { startLine: 1, startChar: 0, endLine: 1, endChar: 5, newText: "CHANGED" },
  ]);
  assert.equal(result, "line1\nCHANGED\nline3");
});

test("applyTextEdits applies multiple non-overlapping edits regardless of order", () => {
  const text = "aaa\nbbb\nccc";
  const result = applyTextEdits(text, [
    { startLine: 0, startChar: 0, endLine: 0, endChar: 3, newText: "AAA" },
    { startLine: 2, startChar: 0, endLine: 2, endChar: 3, newText: "CCC" },
  ]);
  assert.equal(result, "AAA\nbbb\nCCC");
});

test("format_document applies formatter edits and writes the file", async () => {
  const abs = path.join(tmpDir, "fmt.ts");
  fs.writeFileSync(abs, "const x=1", "utf8");
  vscode.__executeCommandImpl = (cmd: string) => {
    assert.equal(cmd, "vscode.executeFormatDocumentProvider");
    return [
      {
        range: { start: { line: 0, character: 7 }, end: { line: 0, character: 8 } },
        newText: " = ",
      },
    ];
  };
  const result = await executeTool("format_document", { path: "fmt.ts" });
  assert.match(result, /Formatted fmt\.ts \(1 edit/);
  assert.equal(fs.readFileSync(abs, "utf8"), "const x = 1");
});

test("format_document reports when there are no formatting changes", async () => {
  const abs = path.join(tmpDir, "fmt.ts");
  fs.writeFileSync(abs, "const x = 1;\n", "utf8");
  vscode.__executeCommandImpl = () => [];
  const result = await executeTool("format_document", { path: "fmt.ts" });
  assert.equal(result, "No formatting changes.");
});

// ---- run_in_terminal ----

test("run_in_terminal sends the command to a visible integrated terminal", async () => {
  const result = await executeTool("run_in_terminal", { command: "npm test" });
  assert.match(result, /Sent command to integrated terminal: npm test/);
  assert.deepEqual(vscode.__terminalSendTextCalls, ["npm test"]);
});

test("run_in_terminal errors when no command is given", async () => {
  const result = await executeTool("run_in_terminal", {});
  assert.equal(result, "Error: command is required");
});

// ---- compact_context ----

test("compact_context delegates to the provided ToolContext hook", async () => {
  const result = await executeTool("compact_context", {}, {
    compactContext: async () => "History compacted (5 \u2192 1 message).",
  });
  assert.equal(result, "History compacted (5 \u2192 1 message).");
});

test("compact_context errors when no ToolContext is supplied", async () => {
  const result = await executeTool("compact_context", {});
  assert.equal(result, "Error: compact_context is not available in this context.");
});

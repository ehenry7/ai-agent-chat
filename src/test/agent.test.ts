import * as assert from "node:assert/strict";
import { test } from "node:test";
import * as path from "path";
import {
  resolvePathInRoot,
  validateHttpUrl,
  decodeHtmlEntities,
  buildSearchUrl,
  parseSearchResults,
  unixCommandHint,
} from "../tools";
import { buildSystemPrompt, parseToolArguments, READONLY_TOOLS } from "../agent";

const ROOT = path.resolve("/workspace");

test("resolvePathInRoot allows a plain relative path", () => {
  const result = resolvePathInRoot(ROOT, "src/index.ts");
  assert.equal(result, path.resolve(ROOT, "src/index.ts"));
});

test("resolvePathInRoot allows nested subdirectories", () => {
  const result = resolvePathInRoot(ROOT, "a/b/c.txt");
  assert.equal(result, path.resolve(ROOT, "a/b/c.txt"));
});

test("resolvePathInRoot rejects ../ escapes", () => {
  assert.throws(() => resolvePathInRoot(ROOT, "../outside.txt"), /escapes the workspace/);
});

test("resolvePathInRoot rejects deeply nested ../ escapes", () => {
  assert.throws(() => resolvePathInRoot(ROOT, "a/../../outside.txt"), /escapes the workspace/);
});

test("resolvePathInRoot rejects absolute paths outside the root", () => {
  const outsideAbs = process.platform === "win32" ? "C:\\Windows\\system32" : "/etc/passwd";
  assert.throws(() => resolvePathInRoot(ROOT, outsideAbs), /escapes the workspace/);
});

test("validateHttpUrl accepts http and https", () => {
  assert.equal(validateHttpUrl("https://example.com").protocol, "https:");
  assert.equal(validateHttpUrl("http://example.com").protocol, "http:");
});

test("validateHttpUrl rejects non-http protocols", () => {
  assert.throws(() => validateHttpUrl("file:///etc/passwd"), /Only http/);
  assert.throws(() => validateHttpUrl("ftp://example.com"), /Only http/);
});

test("validateHttpUrl rejects malformed URLs", () => {
  assert.throws(() => validateHttpUrl("not a url"), /Invalid URL/);
});

test("decodeHtmlEntities strips tags and decodes entities", () => {
  const input = "<b>Fish &amp; Chips</b> &quot;great&quot; &#x27;deal&#x27; &lt;tag&gt;";
  assert.equal(decodeHtmlEntities(input), 'Fish & Chips "great" \'deal\' <tag>');
});

test("buildSearchUrl substitutes and URL-encodes the query", () => {
  const url = buildSearchUrl("https://duckduckgo.com/html/?q=%s", "vs code extensions");
  assert.equal(url, "https://duckduckgo.com/html/?q=vs%20code%20extensions");
});

test("buildSearchUrl falls back to the default template when empty", () => {
  const url = buildSearchUrl("", "test");
  assert.equal(url, "https://duckduckgo.com/html/?q=test");
});

test("parseSearchResults extracts title/url pairs and unwraps uddg redirects", () => {
  const html =
    '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=1">Example <b>Page</b></a>' +
    '<a rel="nofollow" class="result__a" href="https://direct.example.com/">Direct Link</a>';
  const results = parseSearchResults(html, 10);
  assert.equal(results.length, 2);
  assert.equal(results[0], "Example Page\nhttps://example.com/page");
  assert.equal(results[1], "Direct Link\nhttps://direct.example.com/");
});

test("parseSearchResults respects the count limit", () => {
  const html = Array.from(
    { length: 5 },
    (_, i) => `<a rel="nofollow" class="result__a" href="https://example.com/${i}">Result ${i}</a>`
  ).join("");
  const results = parseSearchResults(html, 2);
  assert.equal(results.length, 2);
});

test("parseSearchResults returns empty array when nothing matches", () => {
  assert.deepEqual(parseSearchResults("<html><body>no results</body></html>", 5), []);
});

test("unixCommandHint flags Unix-only commands on Windows", () => {
  assert.match(unixCommandHint("find . -name '*.ts'", "win32") ?? "", /Unix command/);
  assert.match(unixCommandHint("grep -r foo .", "win32") ?? "", /Unix command/);
});

test("unixCommandHint ignores unrelated commands on Windows", () => {
  assert.equal(unixCommandHint("npm run build", "win32"), null);
});

test("unixCommandHint is a no-op on non-Windows platforms", () => {
  assert.equal(unixCommandHint("find . -name '*.ts'", "linux"), null);
  assert.equal(unixCommandHint("find . -name '*.ts'", "darwin"), null);
});

test("buildSystemPrompt mentions every provided tool name", () => {
  const toolNames = ["read_file", "write_file", "edit_file", "run_command"];
  const prompt = buildSystemPrompt(toolNames, "linux");
  for (const name of toolNames) {
    assert.ok(prompt.includes(name), `expected prompt to mention ${name}`);
  }
  assert.match(prompt, /arguments must be one valid JSON object/);
  assert.match(prompt, /search_in_files.*"glob"/);
});

test("parseToolArguments accepts JSON objects and already-parsed objects", () => {
  assert.deepEqual(parseToolArguments('{"query":"find me"}'), { query: "find me" });
  assert.deepEqual(parseToolArguments({ path: "src/agent.ts" }), { path: "src/agent.ts" });
  assert.deepEqual(parseToolArguments(""), {});
});

test("parseToolArguments rejects malformed and non-object arguments", () => {
  assert.throws(() => parseToolArguments('{"query":"text","path": src/agent.ts}'), SyntaxError);
  assert.throws(() => parseToolArguments("[]"), /arguments must be a JSON object/);
  assert.throws(() => parseToolArguments(42), /arguments must be a JSON object/);
});

test("buildSystemPrompt describes powershell.exe on win32", () => {
  const prompt = buildSystemPrompt(["run_command"], "win32");
  assert.match(prompt, /host OS is "win32"/);
  assert.match(prompt, /run_command executes via powershell\.exe/);
});

test("buildSystemPrompt describes bash on non-Windows platforms", () => {
  const linuxPrompt = buildSystemPrompt(["run_command"], "linux");
  assert.match(linuxPrompt, /host OS is "linux"/);
  assert.match(linuxPrompt, /run_command executes via bash/);

  const darwinPrompt = buildSystemPrompt(["run_command"], "darwin");
  assert.match(darwinPrompt, /host OS is "darwin"/);
  assert.match(darwinPrompt, /run_command executes via bash/);
});

test("READONLY_TOOLS contains the expected read-only tool names", () => {
  for (const name of [
    "read_file", "read_file_lines", "list_directory", "search_in_files", "find_files",
    "git_status", "git_log", "fetch_url", "web_search", "get_diagnostics", "get_active_editor",
  ]) {
    assert.ok(READONLY_TOOLS.has(name), `expected READONLY_TOOLS to include ${name}`);
  }
});

test("READONLY_TOOLS excludes mutating tools", () => {
  for (const name of ["write_file", "edit_file", "delete_file", "rename_file", "run_command", "git_commit"]) {
    assert.ok(!READONLY_TOOLS.has(name), `expected READONLY_TOOLS to exclude ${name}`);
  }
});

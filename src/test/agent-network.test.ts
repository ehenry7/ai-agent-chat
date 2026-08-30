import * as assert from "node:assert/strict";
import { test } from "node:test";
import * as http from "http";
import { executeTool, fetchUrl } from "../tools";

async function withLocalServer(
  handler: http.RequestListener,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Local test server did not expose a TCP port");
  }
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

// These tests make REAL outbound network requests (no mocking) to verify
// fetch_url/web_search actually work end-to-end. If the sandbox/CI has no
// internet access (or an internal-only network, as this project's default
// baseUrl suggests), they skip themselves instead of failing the suite.

test("fetch_url retrieves real content from a public URL", async (t) => {
  const result = await executeTool("fetch_url", { url: "https://example.com/" });
  if (result.startsWith("Error:")) {
    t.skip("network unavailable: " + result);
    return;
  }
  assert.match(result, /Example Domain/i);
});

test("web_search returns real results for a query", async (t) => {
  const result = await executeTool("web_search", { query: "OpenAI", count: 3 });
  if (result.startsWith("Error:") || result === "No results found.") {
    t.skip("network/search unavailable: " + result);
    return;
  }
  // Each result is a "title\nurl" pair separated by a blank line.
  const entries = result.split("\n\n");
  assert.ok(entries.length >= 1, "expected at least one search result");
  assert.match(result, /https?:\/\//, "expected at least one result URL");
});

test("fetchUrl follows a relative HTTP 302 redirect", async () => {
  await withLocalServer((req, res) => {
    if (req.url === "/start") {
      res.writeHead(302, { Location: "/final" });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("redirect target content");
  }, async (baseUrl) => {
    assert.equal(await fetchUrl(`${baseUrl}/start`), "redirect target content");
  });
});

test("fetchUrl rejects redirect chains beyond its limit", async () => {
  await withLocalServer((_req, res) => {
    res.writeHead(302, { Location: "/again" });
    res.end();
  }, async (baseUrl) => {
    await assert.rejects(fetchUrl(`${baseUrl}/again`, 1), /too many redirects/);
  });
});

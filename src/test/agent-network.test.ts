import * as assert from "node:assert/strict";
import { test } from "node:test";
import * as http from "http";
import { executeTool, fetchUrl } from "../tools";
import { ApiClient } from "../apiClient";

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

test("ApiClient.chat parses tool calls from a JSON completion response", async () => {
  await withLocalServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" },
          }],
        },
      }],
    }));
  }, async (baseUrl) => {
    const client = new ApiClient({ baseUrl, apiKey: "test", model: "test-model" });
    const message = await client.chat([{ role: "user", content: "read README" }], [{ type: "function", function: { name: "read_file" } }]);
    assert.equal(message.tool_calls?.[0].function.name, "read_file");
    assert.equal(message.tool_calls?.[0].function.arguments, "{\"path\":\"README.md\"}");
  });
});

test("ApiClient.chat rejects a non-2xx response with the body text", async () => {
  await withLocalServer((_req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end('{"error":{"message":"unauthorized"}}');
  }, async (baseUrl) => {
    const client = new ApiClient({ baseUrl, apiKey: "test", model: "test-model" });
    await assert.rejects(client.chat([{ role: "user", content: "hi" }]), /API error 401.*unauthorized/);
  });
});

test("ApiClient.chat rejects a response with no choices", async () => {
  await withLocalServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"choices":[]}');
  }, async (baseUrl) => {
    const client = new ApiClient({ baseUrl, apiKey: "test", model: "test-model" });
    await assert.rejects(client.chat([{ role: "user", content: "hi" }]), /Unexpected API response/);
  });
});

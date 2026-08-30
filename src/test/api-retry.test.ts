import { test } from "node:test";
import * as assert from "node:assert";
import { isRetriableError } from "../apiClient";

test("isRetriableError: timeouts and transient failures are retriable", () => {
    assert.strictEqual(isRetriableError(new Error("API request timed out")), true);
    assert.strictEqual(isRetriableError(Object.assign(new Error("reset"), { code: "ECONNRESET" })), true);
    assert.strictEqual(isRetriableError(new Error("API error 502: Bad Gateway")), true);
    assert.strictEqual(isRetriableError(new Error("API error 429: Too Many Requests")), true);
});

test("isRetriableError: aborts and client errors are not retriable", () => {
    assert.strictEqual(isRetriableError(new Error("Aborted")), false);
    assert.strictEqual(isRetriableError(new Error("API error 401: Unauthorized")), false);
    assert.strictEqual(isRetriableError(new Error("Failed to parse API response: x")), false);
});
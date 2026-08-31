import { test } from "node:test";
import * as assert from "node:assert";
import { buildWebviewHtml, buildCsp } from "../webview/html";
import { buildWebviewScript } from "../webview/script";
import { buildMarkdownScript } from "../webview/markdown";
import { buildMessagesScript } from "../webview/messages";

test("webview html wires nonce into CSP, style, and script tags", () => {
    const nonce = "testnonce123";
    const html = buildWebviewHtml({
        nonce,
        csp: buildCsp(nonce, "vscode-webview-test://"),
        lightIconUri: "vscode-resource:light.svg",
        darkIconUri: "vscode-resource:dark.svg",
    });
    assert.ok(html.includes("script-src 'nonce-" + nonce + "'"));
    assert.ok(html.includes('<style nonce="' + nonce + '">'));
    assert.ok(html.includes('<script nonce="' + nonce + '">'));
    assert.ok(html.includes("acquireVsCodeApi"));
});

test("webview script parts contain no template-literal sequences", () => {
    for (const part of [buildWebviewScript(), buildMarkdownScript(), buildMessagesScript()]) {
        assert.ok(!part.includes("${"), "webview script must not contain ${ (corruption guard)");
    }
});

test("webview script parts declare shared ids used by the protocol", () => {
    const html = buildWebviewHtml({
        nonce: "n",
        csp: buildCsp("n", "src"),
        lightIconUri: "l",
        darkIconUri: "d",
    });
    for (const id of ["modelSelect", "actionMenu",
        "setupOverlay", "debugToggle", "messages", "input", "send", "stop"]) {
        assert.ok(html.includes('id="' + id + '"'), "missing element #" + id);
    }
});
import { test } from "node:test";
import * as assert from "node:assert";
import { buildHighlightScript } from "../webview/highlight";

interface Hl {
    highlightCode: (code: string, lang?: string) => string;
    normalizeLang: (lang: string) => string;
}

function load(): Hl {
    const src = buildHighlightScript() +
        "\nreturn { highlightCode: highlightCode, normalizeLang: normalizeLang };";
    return (new Function(src))() as Hl;
}

test("highlighter: keywords, strings, and comments get classes", () => {
    const hl = load();
    const out = hl.highlightCode('const x = "hi"; // note', 'ts');
    assert.ok(out.includes('hl-kw'), "keyword class missing");
    assert.ok(out.includes('hl-str'), "string class missing");
    assert.ok(out.includes('hl-cmt'), "comment class missing");
});

test("highlighter: code content is HTML-escaped, never injected", () => {
    const hl = load();
    const out = hl.highlightCode('if (a < b) { s = "<b>"; }', 'js');
    assert.ok(out.includes('&lt;b&gt;'), "markup must be escaped");
    assert.ok(!out.includes('<b>'), "raw <b> must not survive");
});

test("highlighter: unknown language falls back to escaped plain text", () => {
    const hl = load();
    const out = hl.highlightCode('SELECT * FROM t', 'brainfuck');
    assert.ok(!out.includes('hl-'), "no spans expected for unknown language");
    assert.strictEqual(out, 'SELECT * FROM t');
});

test("highlighter: language aliases normalize", () => {
    const hl = load();
    assert.strictEqual(hl.normalizeLang('PY'), 'python');
    assert.strictEqual(hl.normalizeLang('ts'), 'typescript');
    assert.strictEqual(hl.normalizeLang('C++'), 'cpp');
});

test("highlighter: python triple-quoted strings and json keys", () => {
    const hl = load();
    assert.ok(hl.highlightCode("'''doc'''", 'python').includes('hl-str'));
    const json = hl.highlightCode('{"a": 1}', 'json');
    assert.ok(json.includes('hl-atr'), "json key class missing");
    assert.ok(json.includes('hl-num'), "json number class missing");
});

test("highlighter: emitted script contains no template-literal sequences", () => {
    assert.ok(!buildHighlightScript().includes("${"), "corruption guard");
});
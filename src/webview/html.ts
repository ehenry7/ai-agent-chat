import { buildWebviewScript } from "./script";
import { buildHighlightScript } from "./highlight";
import { buildMarkdownScript } from "./markdown";
import { buildMessagesScript } from "./messages";
import { buildWebviewCss } from "./styles";

/**
 * Assembles the complete webview HTML document.
 *
 * Pure string builder — no vscode dependency, unit-testable.
 * NOTE: no template literals (see Handoff-Summary.md lessons learned).
 */

export interface WebviewHtmlOptions {
    nonce: string;
    csp: string;
    lightIconUri: string;
    darkIconUri: string;
}

/** Build the Content-Security-Policy meta tag for the webview. */
export function buildCsp(nonce: string, cspSource: string): string {
    return "<meta http-equiv=\"Content-Security-Policy\" " +
        "content=\"default-src 'none'; " +
        "style-src 'nonce-" + nonce + "'; " +
        "script-src 'nonce-" + nonce + "'; " +
        "img-src data: " + cspSource + ";\">";
}

/**
 * Build the full HTML document. The three script parts are concatenated into a
 * SINGLE <script> block: shell first (it holds the "use strict" directive and
 * the shared element/state variables), then the markdown library, then message
 * rendering/dispatch. Function declarations hoist across the whole script, so
 * cross-part calls (e.g. send -> addMessage -> mdRender) work regardless.
 */
export function buildWebviewHtml(opts: WebviewHtmlOptions): string {
    const css = buildWebviewCss(opts.lightIconUri, opts.darkIconUri);
     const script = [
        buildWebviewScript(),
        buildHighlightScript(),
        buildMarkdownScript(),
        buildMessagesScript(),
    ].join("\n");

    const htmlParts: string[] = [];
    htmlParts.push("<!DOCTYPE html>");
    htmlParts.push('<html lang="en">');
    htmlParts.push("<head>");
    htmlParts.push('<meta charset="UTF-8">');
    htmlParts.push(opts.csp);
    htmlParts.push('<style nonce="' + opts.nonce + '">');
    htmlParts.push(css);
    htmlParts.push("</style>");
    htmlParts.push("</head>");
    htmlParts.push("<body>");
    htmlParts.push('<div id="setupOverlay">');
    htmlParts.push('<h2 style="font-size: 14px; margin: 0 0 10px 0;">AI Agent Setup</h2>');
    htmlParts.push('<div class="s-field"><label>Base URL</label><input id="setupBaseUrl" type="text" value="http://techdev.hicomputing.huawei.com:18000" /></div>');
    htmlParts.push('<div class="s-field"><label>Auth Method</label><select id="setupAuthType"><option value="key">API Key</option><option value="env">Environment Variable</option></select></div>');
    htmlParts.push('<div class="s-field"><label id="setupAuthLabel">API Key</label><input id="setupAuthValue" type="password" placeholder="sk-..." /></div>');
    htmlParts.push('<button id="setupTestBtn" class="s-btn">Test Connection</button>');
    htmlParts.push('<div id="setupStatus" style="font-size: 11px;"></div>');
    htmlParts.push('<div class="s-field"><label>Default Model</label><select id="setupModelSelect"><option value="">Test connection first...</option></select></div>');
    htmlParts.push('<div class="s-field"><label>Max Steps</label><input id="setupMaxSteps" type="number" min="1" max="500" value="25" /></div>');
    htmlParts.push('<button id="setupSaveBtn" class="s-btn" disabled>Save & Close</button>');
    htmlParts.push('</div>');
    htmlParts.push('<div id="modelHeader">');
    htmlParts.push('<div class="my-theme-icon" style="margin-right: 6px;"></div>');
    htmlParts.push('<label for="modelSelect">Model:</label>');
    htmlParts.push('<select id="modelSelect"><option value="">(Loading models...)</option></select>');
    htmlParts.push('<button id="refreshModels" title="Refresh available models from server">🔄</button>');
    htmlParts.push('<button id="timeModels" title="Measure response time of each model">⏱</button>');
    htmlParts.push('<button id="compactBtn" title="Compact conversation context (summarize history to save tokens)">🗜️</button>');
    htmlParts.push('<button id="settingsBtn" title="Open Setup / Settings">⚙️</button>');
    htmlParts.push('</div>');
    htmlParts.push('<div id="status" class="st">BOOT: script not running yet</div>');
    htmlParts.push('<div id="messages"></div>');
    htmlParts.push('<div id="debugWrap" class="collapsed">');
    htmlParts.push('<div id="debugToggle">▸ debug log</div>');
    htmlParts.push('<div id="debug"><div class="dbg">[debug log - will fill if script runs]</div></div>');
    htmlParts.push('</div>');
    htmlParts.push('<div id="inputArea">');
    htmlParts.push('<textarea id="input" rows="2" placeholder="Ask the agent... (↑/↓ history)"></textarea>');
    htmlParts.push('<button id="send">Send</button>');
    htmlParts.push('<button id="stop" disabled title="Stop the current agent run">Stop</button>');
    htmlParts.push("</div>");
    htmlParts.push('<script nonce="' + opts.nonce + '">');
    htmlParts.push(script);
    htmlParts.push("</script>");
    htmlParts.push("</body>");
    htmlParts.push("</html>");

    return htmlParts.join("\n");
}
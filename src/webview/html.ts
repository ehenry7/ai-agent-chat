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
 * Build the full HTML document.
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
    
    // Setup Overlay
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

    // Messages area
    htmlParts.push('<div id="messages"></div>');
    
    // Debug log
    htmlParts.push('<div id="debugWrap" class="collapsed">');
    htmlParts.push('<div id="debugToggle">▸ debug log</div>');
    htmlParts.push('<div id="debug"><div class="dbg">[debug log - will fill if script runs]</div></div>');
    htmlParts.push('</div>');
    
    // Input area container
    htmlParts.push('<div id="inputAreaContainer">');
    htmlParts.push('<div id="status" class="st">BOOT: script not running yet</div>');
    htmlParts.push('<div id="inputGrip" title="Drag to resize prompt area"></div>');

    // Quick File Attachment popup (for @ and +). Populated by script.ts on
    // demand; hidden until the user types '@' or clicks the [+] button.
    htmlParts.push('<div id="fileAttachMenu" style="display:none;"></div>');

    htmlParts.push('<textarea id="input" rows="2" placeholder="Ask the agent... (@ to attach file, / for commands)"></textarea>');

    htmlParts.push('<div id="promptToolbar">');
    htmlParts.push('<button id="addFileBtn" title="Attach open file or browse...">+</button>');
    htmlParts.push('<select id="modelSelect" title="Select AI Model"><option value="">(Loading models...)</option></select>');
    htmlParts.push('<select id="actionMenu" title="More Actions">');
    htmlParts.push('<option value="">☰ Menu</option>');
    htmlParts.push('<option value="refresh">🔄 Refresh Models</option>');
    htmlParts.push('<option value="time">⏱ Benchmark Models</option>');
    htmlParts.push('<option value="compact">🗜️ Compact Context</option>');
    htmlParts.push('<option value="clear">🗑️ Clear Chat</option>');
    htmlParts.push('<option value="settings">⚙️ Settings</option>');
    htmlParts.push('</select>');
    htmlParts.push('<div class="spacer"></div>');
    
    htmlParts.push('<div id="sendStopStack">');
    htmlParts.push('<button id="send" title="Send message (Enter)">➤</button>');
    htmlParts.push('<button id="stop" disabled title="Stop the current agent run">■</button>');
    htmlParts.push('</div>');
    htmlParts.push('</div>');
    htmlParts.push('</div>');

    // Script injection
    htmlParts.push('<script nonce="' + opts.nonce + '">');
    htmlParts.push(script);
    htmlParts.push("</script>");
    htmlParts.push("</body>");
    htmlParts.push("</html>");

    return htmlParts.join("\n");
}
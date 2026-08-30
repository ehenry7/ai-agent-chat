import * as vscode from "vscode";

/**
 * Sidebar chat view (WebviewView) with extensive diagnostics.
 *
 * NOTE: This file deliberately contains NO template literals.
 * All dynamic HTML is built with string concatenation, because
 * ${ sequences have been corrupted repeatedly during AI-assisted
 * edits in this project (see Handoff-Summary.md lessons learned).
 */

// Build a nonce without template literals and without Math.random map tricks
function makeNonce(): string {
    let n = "";
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
        n += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return n;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewId = "ai-agent-chat.chatView";

    private _view?: vscode.WebviewView;
    private _messageHandlers: Array<(msg: any) => void> = [];
    private _log: vscode.OutputChannel;

    constructor(private readonly context: vscode.ExtensionContext) {
        this._log = vscode.window.createOutputChannel("AI Agent Chat");
        this._log.appendLine("[provider] constructed");
    }

    private log(msg: string): void {
        this._log.appendLine(msg);
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.log("[provider] resolveWebviewView called");

        this._view = view;

        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.context.extensionUri],
        };

        const nonce = makeNonce();
        const csp =
            "<meta http-equiv=\"Content-Security-Policy\" " +
            "content=\"default-src 'none'; " +
            "style-src 'nonce-" + nonce + "'; " +
            "script-src 'nonce-" + nonce + "'; " +
            "img-src data: " + view.webview.cspSource + ";\">";
        this.log("[provider] CSP built, nonce length=" + nonce.length);

        view.webview.html = this._getHtml(nonce, csp, view.webview);
        this.log("[provider] html assigned, length=" + view.webview.html.length);

        view.webview.onDidReceiveMessage((msg: any) => {
            this.log("[provider] message from webview: " + JSON.stringify(msg).substring(0, 300));
            for (const handler of this._messageHandlers) {
                try {
                    handler(msg);
                } catch (e: any) {
                    this.log("[provider] message handler error: " + String(e));
                }
            }
        });

        // Signal webview readiness / visibility changes
        view.onDidChangeVisibility(() => {
            this.log("[provider] visibility changed: visible=" + String(view.visible));
        });
    }

    onMessage(handler: (msg: any) => void): void {
        this.log("[provider] onMessage handler registered");
        this._messageHandlers.push(handler);
    }

    /** Register a handler for user chat messages (panel-era API kept). */
    onUserMessage(handler: (text: string, model?: string) => void): void {
        this.onMessage((msg: any) => {
            if (msg && msg.type === "userMessage" && typeof msg.text === "string") {
                void handler(msg.text, msg.model);
            }
        });
    }

    post(message: any): void {
        if (!this._view) {
            this.log("[provider] post skipped (no view): " + JSON.stringify(message).substring(0, 120));
            return;
        }
        this.log("[provider] post -> " + JSON.stringify(message).substring(0, 120));
        void this._view.webview.postMessage(message).then(
            () => { /* delivered */ },
            (err: any) => { this.log("[provider] postMessage FAILED: " + String(err)); }
        );
    }

    /** Compatibility alias for the former WebviewPanel API. */
    postMessage(message: any): void {
        this.post(message);
    }

    get isReady(): boolean {
        return this._view !== undefined;
    }

    /** Required for context.subscriptions.push(provider). */
    dispose(): void {
        this._log.appendLine("[provider] dispose called");
        this._view = undefined;
        this._messageHandlers = [];
    }

    private _getHtml(nonce: string, csp: string, webview: vscode.Webview): string {

        // 1. Resolve the secure URIs for your icons[cite: 1]
        const lightIconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "chat-icon-light.svg")).toString();
        const darkIconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "chat-icon-dark.svg")).toString();

        // ---- Status/debug banner: proves whether the script executed. ----
        // If the banner stays "BOOT: script not running", the script is blocked
        // or the HTML is malformed. If it turns green, the webview is alive.
        const js = [
            '"use strict";',
            "var vscode = acquireVsCodeApi();",
            "var statusEl = document.getElementById('status');",
            "var messages = document.getElementById('messages');",
            "var input = document.getElementById('input');",
            "var send = document.getElementById('send');",
            "var stop = document.getElementById('stop');",
            "var modelSelect = document.getElementById('modelSelect');",
            "var refreshModels = document.getElementById('refreshModels');",
            "var timeModels = document.getElementById('timeModels');",
            "var compactBtn = document.getElementById('compactBtn');",
            "var settingsBtn = document.getElementById('settingsBtn');",
            "var setupOverlay = document.getElementById('setupOverlay');",
            "var setupBaseUrl = document.getElementById('setupBaseUrl');",
            "var setupAuthType = document.getElementById('setupAuthType');",
            "var setupAuthLabel = document.getElementById('setupAuthLabel');",
            "var setupAuthValue = document.getElementById('setupAuthValue');",
            "var setupTestBtn = document.getElementById('setupTestBtn');",
            "var setupStatus = document.getElementById('setupStatus');",
            "var setupModelSelect = document.getElementById('setupModelSelect');",
            "var setupMaxSteps = document.getElementById('setupMaxSteps');",
            "var setupSaveBtn = document.getElementById('setupSaveBtn');",
            "var line = 0;",
            "var knownModels = [];",
            "var timings = {};",
            "function updateSetupAuthInput(authType, authValue, apiKeyStored) {",
            "  if (!setupAuthLabel || !setupAuthValue) { return; }",
            "  if (authType === 'env') {",
            "    setupAuthLabel.textContent = 'Env Var Name'; setupAuthValue.placeholder = 'e.g. OPENAI_API_KEY'; setupAuthValue.type = 'text';",
            "    if (authValue !== undefined) { setupAuthValue.value = authValue; }",
            "  } else {",
            "    setupAuthLabel.textContent = 'API Key'; setupAuthValue.type = 'password';",
            "    setupAuthValue.placeholder = apiKeyStored ? 'Stored securely; enter only to replace' : 'sk-...';",
            "    if (authValue !== undefined) { setupAuthValue.value = ''; }",
            "  }",
            "}",
            "if(setupAuthType) {",
            "  setupAuthType.addEventListener('change', function() {",
            "    updateSetupAuthInput(this.value, '', false);",
            "  });",
            "}",
            "if(setupTestBtn) {",
            "  setupTestBtn.addEventListener('click', function() {",
            "    setupStatus.textContent = 'Testing...'; setupStatus.style.color = 'var(--vscode-descriptionForeground)';",
            "    vscode.postMessage({ type: 'testConnection', baseUrl: setupBaseUrl.value, authType: setupAuthType.value, authValue: setupAuthValue.value });",
            "  });",
            "}",
            "if(setupSaveBtn) {",
            "  setupSaveBtn.addEventListener('click', function() {",
            "    vscode.postMessage({ type: 'saveSetup', baseUrl: setupBaseUrl.value, authType: setupAuthType.value, authValue: setupAuthValue.value, model: setupModelSelect.value, maxSteps: setupMaxSteps ? setupMaxSteps.value : '15' });",
            "  });",
            "}",
            "function setStatus(t, cls) {",
            "    if (statusEl) { statusEl.textContent = t;",
            "        statusEl.className = cls || 'st';",
            "        statusEl.style.display = 'block'; }",
            "}",
            "function logLine(t) {",
            "    line++;",
            "    var d = document.createElement('div');",
            "    d.textContent = line + ': ' + t;",
            "    d.className = 'dbg';",
            "    var dbg = document.getElementById('debug');",
            "    if (dbg) { dbg.appendChild(d); dbg.scrollTop = dbg.scrollHeight; }",
            "}",
            "function labelFor(m) {",
            "    var t = timings[m];",
            "    if (t === undefined) { return m; }",
            "    if (t === null) { return m + '  (timing...)'; }",
            "    if (t < 0) { return m + '  (failed)'; }",
            "    return m + '  (' + t + ' ms)';",
            "}",
            "function renderModelOptions() {",
            "    if (!modelSelect) { return; }",
            "    var keep = modelSelect.value;",
            "    modelSelect.innerHTML = '';",
            "    knownModels.forEach(function (m) {",
            "        var opt = document.createElement('option');",
            "        opt.value = m;",
            "        opt.textContent = labelFor(m);",
            "        if (m === keep) { opt.selected = true; }",
            "        modelSelect.appendChild(opt);",
            "    });",
            "}",
            "function updateModelOptions(models, selected) {",
            "    if (!modelSelect) { return; }",
            "    var list = Array.isArray(models) ? models.slice() : [];",
            "    if (selected && list.indexOf(selected) === -1) {",
            "        list.unshift(selected);",
            "    }",
            "    if (list.length === 0 && selected) {",
            "        list.push(selected);",
            "    }",
            "    knownModels = list;",
            "    modelSelect.innerHTML = '';",
            "    list.forEach(function (m) {",
            "        var opt = document.createElement('option');",
            "        opt.value = m;",
            "        opt.textContent = labelFor(m);",
            "        if (m === selected) { opt.selected = true; }",
            "        modelSelect.appendChild(opt);",
            "    });",
            "}",
            "window.onerror = function (msg, src, l, c) {",
            "    var t = 'SCRIPT ERROR: ' + msg + ' @' + l + ':' + c;",
            "    setStatus('SCRIPT ERROR (see debug)', 'st-err');",
            "    logLine(t);",
            "    try { vscode.postMessage({ type: 'webviewError', text: t }); } catch (e) {}",
            "    return false;",
            "};",
            "logLine('script started');",
            "setStatus('WEBVIEW ALIVE - script running', 'st-ok');",
            "try { vscode.postMessage({ type: 'webviewReady' }); logLine('webviewReady sent'); }",
            "catch (e) { logLine('postMessage failed: ' + e); }",
            "if (refreshModels) {",
            "    refreshModels.addEventListener('click', function () {",
            "        vscode.postMessage({ type: 'fetchModels' });",
            "        setStatus('fetching models...', 'st-wait');",
            "    });",
            "}",
            "if (timeModels) {",
            "    timeModels.addEventListener('click', function () {",
            "        timeModels.disabled = true;",
            "        knownModels.forEach(function (m) { timings[m] = null; });",
            "        renderModelOptions();",
            "        vscode.postMessage({ type: 'benchmarkModels' });",
            "        setStatus('measuring model response times...', 'st-wait');",
            "    });",
            "}",
            "if (compactBtn) {",
            "    compactBtn.addEventListener('click', function () {",
            "        compactBtn.disabled = true;",
            "        vscode.postMessage({ type: 'compact' });",
            "        setStatus('compacting context...', 'st-wait');",
            "    });",
            "}",
            "if (settingsBtn) {",
            "    settingsBtn.addEventListener('click', function () {",
            "        vscode.postMessage({ type: 'openSettings' });",
            "        setStatus('opening setup...', 'st-wait');",
            "    });",
            "}",
            "if (modelSelect) {",
            "    modelSelect.addEventListener('change', function () {",
            "        var sel = modelSelect.value;",
            "        vscode.postMessage({ type: 'selectModel', model: sel });",
            "        logLine('selected model: ' + sel);",
            "    });",
            "}",
            "function addMessage(role, text) {",
            "    var div = document.createElement('div');",
            "    div.className = 'msg ' + role;",
            "    if (role === 'assistant') {",
            "        var icon = document.createElement('div');",
            "        icon.className = 'my-theme-icon';",
            "        icon.style.cssFloat = 'left';",
            "        icon.style.marginRight = '8px';",
            "        div.appendChild(icon);",
            "    }",            
            "    var pre = document.createElement('pre');",
            "    pre.textContent = text;",
            "    div.appendChild(pre);",
            "    messages.appendChild(div);",
            "    messages.scrollTop = messages.scrollHeight;",
            "}",
            "send.addEventListener('click', function () {",
            "    var text = input.value.trim();",
            "    if (!text) { return; }",
            "    var selectedModel = modelSelect ? modelSelect.value : '';",
            "    addMessage('user', text);",
            "    vscode.postMessage({ type: 'userMessage', text: text, model: selectedModel });",
            "    input.value = '';",
            "    send.disabled = true;",
            "    if (stop) { stop.disabled = false; }",
            "    setStatus('waiting for agent...', 'st-wait');",
            "});",
            "if (stop) {",
            "    stop.addEventListener('click', function () {",
            "        vscode.postMessage({ type: 'stop' });",
            "        stop.disabled = true;",
            "        setStatus('stopping...', 'st-wait');",
            "    });",
            "}",
            "input.addEventListener('keydown', function (e) {",
            "    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send.click(); }",
            "});",
            "window.addEventListener('message', function (event) {",
            "    var msg = event.data;",
            "    logLine('recv: ' + JSON.stringify(msg).substring(0, 120));",
            "    if (!msg || !msg.type) { return; }",
            "    switch (msg.type) {",
            "        case 'showSetup':",
            "            if (setupMaxSteps) setupMaxSteps.value = String(msg.maxSteps || 15);",
            "            if (setupAuthType) setupAuthType.value = msg.authType === 'env' ? 'env' : 'key';",
            "            updateSetupAuthInput(msg.authType, msg.authValue, Boolean(msg.apiKeyStored));",
            "            if (setupOverlay) setupOverlay.style.display = 'flex';",
            "            break;",
            "        case 'hideSetup':",
            "            if (setupOverlay) setupOverlay.style.display = 'none';",
            "            break;",
            "        case 'setupModelsList':",
            "            if (setupModelSelect) {",
            "                setupModelSelect.innerHTML = '';",
            "                msg.models.forEach(function(m) {",
            "                    var opt = document.createElement('option');",
            "                    opt.value = m;",
            "                    opt.textContent = m;",
            "                    setupModelSelect.appendChild(opt);",
            "                });",
            "            }",
            "            if (setupStatus) { setupStatus.textContent = 'Success! Pick a model.'; setupStatus.style.color = '#104a10'; }",
            "            if (setupSaveBtn) setupSaveBtn.disabled = false;",
            "            break;",
            "        case 'setupError':",
            "            if (setupStatus) { setupStatus.textContent = 'Error: ' + msg.text; setupStatus.style.color = 'var(--vscode-errorForeground)'; }",
            "            break;",
            "        case 'modelsList':",
            "            updateModelOptions(msg.models, msg.selected);",
            "            setStatus(msg.error ? 'failed fetching models' : 'ready', msg.error ? 'st-err' : 'st-ok');",
            "            break;",
            "        case 'modelTiming':",
            "            timings[msg.model] = (typeof msg.ms === 'number') ? msg.ms : -1;",
            "            renderModelOptions();",
            "            break;",
            "        case 'benchmarkDone':",
            "            if (timeModels) { timeModels.disabled = false; }",
            "            setStatus('timing complete', 'st-ok');",
            "            break;",
            "        case 'delta':",
            "            addMessage('assistant', msg.text);",
            "            setStatus('streaming...', 'st-wait');",
            "            break;",
            "        case 'done':",
            "            send.disabled = false;",
            "            if (stop) { stop.disabled = true; }",
            "            if (compactBtn) { compactBtn.disabled = false; }",
            "            setStatus('ready', 'st-ok');",
            "            break;",
            "        case 'error':",
            "            addMessage('error', msg.text || 'An error occurred.');",
            "            send.disabled = false;",
            "            if (stop) { stop.disabled = true; }",
            "            if (compactBtn) { compactBtn.disabled = false; }",
            "            setStatus('error', 'st-err');",
            "            break;",
            "        case 'tool':",
            "            addMessage('tool', msg.text || '');",
            "            break;",
            "        case 'renderHistory':",
            "            (msg.items || []).forEach(function (it) { addMessage(it.role, it.text); });",
            "            break;",
            "        default:",
            "            logLine('unknown msg.type: ' + msg.type);",
            "    }",
            "});",
            "logLine('script finished setup OK');",
        ].join("\n");

        const htmlParts: string[] = [];
        htmlParts.push("<!DOCTYPE html>");
        htmlParts.push('<html lang="en">');
        htmlParts.push("<head>");
        htmlParts.push('<meta charset="UTF-8">');
        htmlParts.push(csp);
        htmlParts.push('<style nonce="' + nonce + '">');
        htmlParts.push([
            ":root { color-scheme: light dark; }",
            "body { font-family: var(--vscode-font-family);",
            "  font-size: var(--vscode-font-size);",
            "  color: var(--vscode-foreground);",
            "  margin: 0; display: flex; flex-direction: column; height: 100vh; }",
            "#modelHeader { display: flex; align-items: center; gap: 6px; padding: 6px 8px;",
            "  border-bottom: 1px solid var(--vscode-panel-border); font-size: 11px; }",
            "#modelSelect { flex: 1; background: var(--vscode-dropdown-background);",
            "  color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border);",
            "  padding: 3px 6px; font-size: 11px; border-radius: 2px; }",
            "#refreshModels, #timeModels, #compactBtn { background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));",
            "  color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));",
            "  border: none; padding: 3px 8px; cursor: pointer; border-radius: 2px; font-size: 11px; }",
            "#refreshModels:hover, #timeModels:hover, #compactBtn:hover { opacity: 0.8; }",
            "#timeModels:disabled, #compactBtn:disabled { opacity: 0.4; cursor: default; }",
            "#status { display: none; padding: 4px 8px; font-size: 11px;",
            "  font-family: monospace; }",
            ".st-ok { background: #104a10; color: #c8f7c8; display: block; }",
            ".st-err { background: #5a1010; color: #ffd6d6; display: block; }",
            ".st-wait { background: #4a4210; color: #fff3c8; display: block; }",
            ".st { display: block; }",
            "#debug { max-height: 90px; overflow-y: auto; font-size: 10px;",
            "  font-family: monospace; color: var(--vscode-descriptionForeground);",
            "  border-top: 1px dashed var(--vscode-panel-border); }",
            ".dbg { white-space: pre-wrap; }",
            "#messages { flex: 1; overflow-y: auto; padding: 8px; }",
            ".msg { margin: 6px 0; padding: 6px 8px; border-radius: 6px;",
            "  width: 100%; box-sizing: border-box; overflow-wrap: break-word; }",
            ".msg.user { background: var(--vscode-input-background); }",
            ".msg.assistant { background: var(--vscode-editorWidget-background); }",
            ".msg.tool { background: var(--vscode-textCodeBlock-background);",
            "  font-family: var(--vscode-editor-font-family); }",
            ".msg.tool pre { overflow-x: auto; margin: 0; white-space: pre-wrap; }",
            ".msg.error { color: var(--vscode-errorForeground); }",
            ".msg pre { margin: 0; white-space: pre-wrap; font-family: inherit; }",
            "#inputArea { display: flex; gap: 6px; padding: 8px;",
            "  border-top: 1px solid var(--vscode-panel-border); }",
            "#input { flex: 1; background: var(--vscode-input-background);",
            "  color: var(--vscode-input-foreground);",
            "  border: 1px solid var(--vscode-input-border); padding: 6px; resize: none; }",
            "#send { background: var(--vscode-button-background);",
            "  color: var(--vscode-button-foreground); border: none;",
            "  padding: 6px 14px; cursor: pointer; }",
            "#send:disabled { opacity: 0.5; cursor: default; }",
            "#stop { background: var(--vscode-errorForeground); color: white; border: none;",
            "  padding: 6px 14px; cursor: pointer; }",
            "#stop:disabled { opacity: 0.4; cursor: default; }",
            ".my-theme-icon { content: url('" + lightIconUri + "'); width: 24px; height: 24px; }",
            "body.vscode-dark .my-theme-icon, body.vscode-high-contrast .my-theme-icon { content: url('" + darkIconUri + "'); }",
            "#setupOverlay { display: none; position: absolute; top: 0; left: 0; width: 100%; height: 100%; box-sizing: border-box; background: var(--vscode-sideBar-background); z-index: 9999; padding: 15px; overflow-y: auto; flex-direction: column; gap: 12px; }",
            ".s-field { display: flex; flex-direction: column; gap: 6px; }",
            ".s-field label { font-weight: bold; font-size: 11px; }",
            ".s-field input, .s-field select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 6px; font-size: 11px; box-sizing: border-box; width: 100%; }",
            ".s-btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 8px; cursor: pointer; font-size: 11px; width: 100%; }",
            ".s-btn:hover { background: var(--vscode-button-hoverBackground); }",
            ".s-btn:disabled { opacity: 0.5; cursor: default; }"
        ].join("\n"));
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
        htmlParts.push('<div id="debug"><div class="dbg">[debug log - will fill if script runs]</div></div>');
        htmlParts.push('<div id="inputArea">');
        htmlParts.push('<textarea id="input" rows="2" placeholder="Ask the agent..."></textarea>');
        htmlParts.push('<button id="send">Send</button>');
        htmlParts.push('<button id="stop" disabled title="Stop the current agent run">Stop</button>');
        htmlParts.push("</div>");
        htmlParts.push('<script nonce="' + nonce + '">');
        htmlParts.push(js);
        htmlParts.push("</script>");
        htmlParts.push("</body>");
        htmlParts.push("</html>");

        return htmlParts.join("\n");
    }
}
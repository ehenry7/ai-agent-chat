import * as vscode from "vscode";
import { buildWebviewHtml, buildCsp } from "./webview/html";

/**
 * Sidebar chat view (WebviewView) with extensive diagnostics.
 *
 * The webview's HTML/CSS/JS live in src/webview/* as pure string builders
 * (no vscode dependency, unit-testable). This class only handles the
 * VS Code side: view lifecycle, message routing, and logging.
 *
 * NOTE: This project deliberately uses NO template literals in webview
 * string building — see Handoff-Summary.md lessons learned.
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
    private _wiredWebviews = new WeakSet<vscode.Webview>();
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
        const csp = buildCsp(nonce, view.webview.cspSource);
        this.log("[provider] CSP built, nonce length=" + nonce.length);

        const lightIconUri = view.webview
            .asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "chat-icon-light.svg"))
            .toString();
        const darkIconUri = view.webview
            .asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "chat-icon-dark.svg"))
            .toString();

        view.webview.html = buildWebviewHtml({
            nonce,
            csp,
            lightIconUri,
            darkIconUri,
        });
        this.log("[provider] html assigned, length=" + view.webview.html.length);

        // Defensive: if the same webview were ever resolved twice, registering a
        // second onDidReceiveMessage forwarder would duplicate every message
        // delivered to the extension-host handlers.
        if (!this._wiredWebviews.has(view.webview)) {
            this._wiredWebviews.add(view.webview);
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
        }

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
}
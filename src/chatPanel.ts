import * as vscode from "vscode";

type WebviewMessage = { type: string; text?: string; name?: string };

export class ChatPanel implements vscode.Disposable {
  public static current: ChatPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private userMessageHandler: ((text: string) => void) | undefined;

  private constructor(extensionUri: vscode.Uri) {
    this.panel = vscode.window.createWebviewPanel(
      "aiAgentChat",
      "AI Agent Chat",
      vscode.ViewColumn.Two,
      { enableScripts: true }
    );

    ChatPanel.current = this;

    this.panel.onDidDispose(() => {
      ChatPanel.current = undefined;
    });

    this.panel.webview.onDidReceiveMessage((msg: any) => {
      if (msg?.type === "user" && typeof msg.text === "string") {
        this.userMessageHandler?.(msg.text);
      }
    });

    this.panel.webview.html = this.getHtml();
  }

  public static create(extensionUri: vscode.Uri): ChatPanel {
    if (ChatPanel.current) {
      ChatPanel.current.reveal();
      return ChatPanel.current;
    }
    return new ChatPanel(extensionUri);
  }

  public reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Two);
  }

  public onUserMessage(handler: (text: string) => void): void {
    this.userMessageHandler = handler;
  }

  public postMessage(msg: WebviewMessage): void {
     // Guard: posting to a disposed panel rejects unhandled and can throw.
    try {
      void this.panel.webview.postMessage(msg).then(undefined, () => {
        // Panel already disposed — drop the message silently.
      });
    } catch {
      // Panel already disposed — drop the message synchronously.
    }
  }

  public dispose(): void {
    this.panel.dispose();
  }

  private getHtml(): string {
    const nonce = Math.random().toString(36).slice(2);
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>AI Agent Chat</title>
  <style>
    body { font-family: sans-serif; padding: 8px; }
    #log { white-space: pre-wrap; }
    .user { color: var(--vscode-editor-foreground); font-weight: bold; margin-top: 8px; }
    .assistant { color: var(--vscode-editor-foreground); margin-top: 4px; }
    .status { color: var(--vscode-descriptionForeground); font-style: italic; }
    .tool { color: var(--vscode-terminal-ansiBlue); font-family: monospace; }
    .error { color: var(--vscode-errorForeground); }
    #bar { display: flex; gap: 4px; margin-top: 8px; }
    #input { flex: 1; }
  </style>
</head>
<body>
  <div id="log"></div>
  <div id="bar">
    <input id="input" type="text" placeholder="Ask the agent..." />
    <button id="send">Send</button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const log = document.getElementById("log");
    const input = document.getElementById("input");
    const send = document.getElementById("send");

    function append(cls, text) {
      const div = document.createElement("div");
      div.className = cls;
      div.textContent = text; // textContent, never innerHTML — no XSS
      log.appendChild(div);
    }

    send.addEventListener("click", () => {
      const text = input.value.trim();
      if (!text) { return; }
      vscode.postMessage({ type: "user", text });
      append("user", "> " + text);
      input.value = "";
      send.disabled = true;
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { send.click(); }
    });

    window.addEventListener("message", (event) => {
      const msg = event.data;
      switch (msg.type) {
        case "user":
          append("user", msg.text);
          break;
        case "assistant":
          append("assistant", msg.text);
          break;
        case "status":
          append("status", msg.text);
          break;
        case "tool":
          append("tool", "[tool: " + msg.name + "]\\n" + msg.text);
          break;
        case "error":
          append("error", msg.text);
          break;
      }
      if (msg.type === "assistant" || msg.type === "error" || msg.type === "done") {
        send.disabled = false;
      }
    });
  </script>
</body>
</html>`;
  }
}

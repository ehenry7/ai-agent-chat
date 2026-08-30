import * as vscode from "vscode";
import { runAgent } from "./agent";
import { ChatMessage } from "./apiClient";
import { ApiClient } from "./apiClient";
import { ChatPanel } from "./chatPanel";

const MAX_HISTORY = 20;

/** Normalize an API key: trim whitespace, strip accidental prefixes. */
function normalizeApiKey(raw: string): string {
  let k = (raw ?? "").trim();
  if (k.toLowerCase().startsWith("key:")) {
    k = k.slice(4).trim();
  }
  if (k.toLowerCase().startsWith("bearer ")) {
    k = k.slice(7).trim();
  }
  return k;
}

/** Load config from settings; returns null and runs onboarding if key is missing. */
async function loadConfig(): Promise<{ apiKey: string; baseUrl: string; model: string } | null> {
  const cfg = vscode.workspace.getConfiguration("aiAgentChat");

  let apiKey = normalizeApiKey(cfg.get<string>("apiKey", ""));

  if (!apiKey) {
    const entered = await vscode.window.showInputBox({
      prompt: "Enter your API key",
      password: true,
      ignoreFocusOut: true,
    });
    apiKey = normalizeApiKey(entered ?? "");
    if (!apiKey) {
      vscode.window.showErrorMessage("API key is required to use AI Agent Chat.");
      return null;
    }
    // Save the CLEAN key — no prefix, no whitespace.
    await cfg.update("apiKey", apiKey, vscode.ConfigurationTarget.Workspace);
    vscode.window.showInformationMessage("API key saved (normalized, without prefix).");
  }

  let baseUrl = (cfg.get<string>("baseUrl", "") || "").trim();
  if (!baseUrl) {
    const entered = (await vscode.window.showInputBox({
      prompt: "Enter base URL of OpenAI-compatible API (e.g. http://host:18000)",
      ignoreFocusOut: true,
    }))?.trim();
    if (!entered) {
      vscode.window.showErrorMessage("Base URL is required to use AI Agent Chat.");
      return null;
    }
    baseUrl = entered;
    await cfg.update("baseUrl", baseUrl, vscode.ConfigurationTarget.Workspace);
  }

  let model = (cfg.get<string>("model", "") || "").trim();
  if (!model) {
    const entered = (await vscode.window.showInputBox({
      prompt: "Enter model name (e.g. GLM-4.6)",
      value: "GLM-4.6",
      ignoreFocusOut: true,
    }))?.trim();
    if (!entered) {
      vscode.window.showErrorMessage("Model name is required to use AI Agent Chat.");
      return null;
    }
    model = entered;
    await cfg.update("model", model, vscode.ConfigurationTarget.Workspace);
  }

  return { apiKey, baseUrl, model };
}

export function activate(context: vscode.ExtensionContext) {
  // --- One-time migration: repair poisoned keys stored by earlier versions ---
  const cfg = vscode.workspace.getConfiguration("aiAgentChat");
  const rawKey = cfg.get<string>("apiKey", "");
  const cleanKey = normalizeApiKey(rawKey);
  if (cleanKey !== rawKey) {
    void cfg
      .update("apiKey", cleanKey, vscode.ConfigurationTarget.Workspace)
      .then(() => {
        console.log("[aiAgentChat] normalized stored apiKey (removed prefix/whitespace).");
      });
  }

  const disposable = vscode.commands.registerCommand("aiAgentChat.open", async () => {
    // Focus existing panel instead of opening a duplicate.
    if (ChatPanel.current) {
      ChatPanel.current.reveal();
      return;
    }

    const panel = ChatPanel.create(context.extensionUri);

    const config = await loadConfig();
    if (!config) {
      panel.postMessage({ type: "error", text: "Configuration incomplete — see notifications." });
      return;
    }

    let history: ChatMessage[] = [];

    panel.onUserMessage(async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }

      // Re-read config fresh each turn so settings changes take effect.
      const cfgNow = vscode.workspace.getConfiguration("aiAgentChat");
      const currentCfg = {
        apiKey: normalizeApiKey(cfgNow.get<string>("apiKey", "")) || config.apiKey,
        baseUrl: (cfgNow.get<string>("baseUrl", "") || "").trim() || config.baseUrl,
        model: (cfgNow.get<string>("model", "") || "").trim() || config.model,
      };

      if (!currentCfg.apiKey) {
        panel.postMessage({ type: "error", text: "API key is missing. Run 'AI Agent Chat: Open' again to reconfigure." });
        return;
      }

      const client = new ApiClient(currentCfg);
      const pending = { role: "user" as const, content: trimmed };

      try {
        const newMessages = await runAgent(client, history, pending, (m) => {
          if (!ChatPanel.current) { return; } // panel disposed — stop streaming
          panel.postMessage(m);
        });

        // Commit only on success.
        history.push(pending);

        // Keep the OpenAI tool-calling contract intact: assistant messages that
        // carried tool_calls are stripped to plain content, and tool results are
        // summarized into the assistant content (or dropped).
       for (const m of newMessages) {
          if (m.role === "tool") continue;
          history.push(
            m.tool_calls
              ? { role: "assistant" as const, content: m.content ?? "" }
              : m
          );
        }
        history = history.slice(-MAX_HISTORY);
        
      } catch (err: any) {
        panel.postMessage({
          type: "error",
          text: `Agent run failed: ${err?.message ?? String(err)}`,
        });
      } finally {
        panel.postMessage({ type: "done", text: "" });
      }
    });

    context.subscriptions.push(panel);
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}

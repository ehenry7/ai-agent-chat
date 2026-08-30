import * as vscode from "vscode";
import { ApiClient } from "./apiClient";
import { setApiKey } from "./extension";
import { ChatViewProvider } from "./chatPanel";

const DEFAULT_MAX_STEPS = 15;

/** Push the current setup state to the webview (renders the setup screen). */
export async function postSetup(context: vscode.ExtensionContext, panel: ChatViewProvider): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("aiAgentChat");
    const envVar = (cfg.get<string>("apiKeyEnvVar", "") || "").trim();
    const storedKey = await context.secrets.get("aiAgentChat.apiKey");
    panel.post({
        type: "showSetup",
        maxSteps: DEFAULT_MAX_STEPS,
        authType: envVar ? "env" : "key",
        authValue: envVar,
        apiKeyStored: Boolean(storedKey),
    });
}

/** Focus the chat view and reveal the setup screen. Safe to call repeatedly. */
export function showWelcomeScreen(context: vscode.ExtensionContext, panel: ChatViewProvider): void {
    vscode.commands.executeCommand(ChatViewProvider.viewId + ".focus").then(() => {
        setTimeout(() => { void postSetup(context, panel); }, 350);
    });
}

/**
 * Register the handler for setup-related messages (openSettings / testConnection /
 * saveSetup). Must be called exactly ONCE in activate() so the handler is not
 * duplicated on every welcome-screen show and so the ⚙️ button works even for
 * returning users who never see the welcome screen.
 */
export function registerSetupHandler(context: vscode.ExtensionContext, panel: ChatViewProvider): void {
    panel.onMessage(async (msg: any) => {
        if (msg.type === "openSettings") {
            await postSetup(context, panel);
        } else if (msg.type === "testConnection") {
            const tempKey = msg.authType === "env" ? (process.env[msg.authValue] || "") : msg.authValue;
            try {
                const client = new ApiClient({ baseUrl: msg.baseUrl, apiKey: tempKey, model: "" });
                const models = await client.listModels();
                panel.post({ type: "setupModelsList", models: models });
            } catch (err: any) {
                panel.post({ type: "setupError", text: String(err) });
            }
        } else if (msg.type === "saveSetup") {
            const cfg = vscode.workspace.getConfiguration("aiAgentChat");
            await cfg.update("baseUrl", msg.baseUrl, vscode.ConfigurationTarget.Global);
            await cfg.update("model", msg.model, vscode.ConfigurationTarget.Global);
            const rawMaxSteps = Number(msg.maxSteps);
            const maxSteps = Number.isFinite(rawMaxSteps) ? Math.min(50, Math.max(1, rawMaxSteps)) : DEFAULT_MAX_STEPS;
            await cfg.update("maxSteps", maxSteps, vscode.ConfigurationTarget.Global);

            if (msg.authType === "env") {
                await cfg.update("apiKeyEnvVar", msg.authValue, vscode.ConfigurationTarget.Global);
                await context.secrets.delete("aiAgentChat.apiKey");
            } else {
                await cfg.update("apiKeyEnvVar", "", vscode.ConfigurationTarget.Global);
                if (typeof msg.authValue === "string" && msg.authValue.trim()) {
                    await setApiKey(context, msg.authValue);
                }
            }
            vscode.window.showInformationMessage("AI Agent Chat settings saved!");
            panel.post({ type: "hideSetup" });
        }
    });
}

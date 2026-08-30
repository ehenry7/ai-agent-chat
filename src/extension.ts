import * as vscode from "vscode";
import { ChatViewProvider } from "./chatPanel";
import { runAgent } from "./agent";
import { ChatMessage, ApiClient } from "./apiClient";
import { showWelcomeScreen, registerSetupHandler } from "./welcome";

const MAX_HISTORY = 20;
const SECRET_KEY = "aiAgentChat.apiKey";

export function normalizeApiKey(raw: string): string {
    let key = (raw || "").trim();
    key = key.replace(/^key:\s*/i, "");
    key = key.replace(/^bearer\s*/i, "");
    return key.trim();
}

/** Retrieve the API key from VS Code SecretStorage. */
export async function getApiKey(context: vscode.ExtensionContext): Promise<string> {
    const cfg = vscode.workspace.getConfiguration("aiAgentChat");
    const envVar = cfg.get<string>("apiKeyEnvVar");

    if (envVar && process.env[envVar]) {
        return normalizeApiKey(process.env[envVar] || "");
    }

    const key = await context.secrets.get(SECRET_KEY);
    return normalizeApiKey(key || "");
}

/** Store the API key in VS Code SecretStorage. */
export async function setApiKey(context: vscode.ExtensionContext, rawKey: string): Promise<void> {
    const normalized = normalizeApiKey(rawKey);
    if (normalized) {
        await context.secrets.store(SECRET_KEY, normalized);
    } else {
        await context.secrets.delete(SECRET_KEY);
    }
}

/** Prompt user to enter their API key securely via an input box. */
export async function promptForApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
    const val = await vscode.window.showInputBox({
        title: "AI Agent Chat: Set API Key",
        prompt: "Enter your OpenAI-compatible API key (stored securely in SecretStorage)",
        password: true,
        ignoreFocusOut: true,
        placeHolder: "sk-..."
    });

    if (val !== undefined) {
        const normalized = normalizeApiKey(val);
        await setApiKey(context, normalized);
        if (normalized) {
            vscode.window.showInformationMessage("AI Agent Chat: API key stored securely.");
        } else {
            vscode.window.showInformationMessage("AI Agent Chat: API key cleared.");
        }
        return normalized;
    }
    return undefined;
}

export async function activate(context: vscode.ExtensionContext) {
    const out = vscode.window.createOutputChannel("AI Agent Chat");
    out.appendLine("[activate] start");

    // ---- One-time Migration: Plaintext Settings -> SecretStorage ----
    try {
        const cfg = vscode.workspace.getConfiguration("aiAgentChat");
        const legacyKey = cfg.get<string>("apiKey", "");
        const existingSecret = await context.secrets.get(SECRET_KEY);

        if (legacyKey && !existingSecret) {
            const normalized = normalizeApiKey(legacyKey);
            if (normalized) {
                await context.secrets.store(SECRET_KEY, normalized);
                out.appendLine("[activate] migrated legacy apiKey from settings to SecretStorage");
            }
            // Remove plaintext key from settings
            await cfg.update("apiKey", undefined, vscode.ConfigurationTarget.Workspace);
            await cfg.update("apiKey", undefined, vscode.ConfigurationTarget.Global);
            out.appendLine("[activate] removed legacy apiKey from settings.json");
        }
    } catch (e) {
        out.appendLine("[activate] secret migration failed: " + String(e));
    }

    // ---- Fallback config values ----
    const getBaseConfig = () => {
        const cfg = vscode.workspace.getConfiguration("aiAgentChat");
        return {
            baseUrl: (cfg.get<string>("baseUrl", "") || "http://techdev.hicomputing.huawei.com:18000").trim(),
            model: (cfg.get<string>("model", "") || "GLM-5.2-1").trim(),
        };
    };

    const initialConfig = getBaseConfig();
    const initialKey = await getApiKey(context);
    out.appendLine("[activate] baseUrl=" + initialConfig.baseUrl + " model=" + initialConfig.model +
        " apiKeyPresent=" + String(initialKey.length > 0));

    // ---- Conversation history & state ----
    const history: ChatMessage[] = [];
    let selectedModel = initialConfig.model;
    let currentRun: AbortController | undefined;

    // ---- Provider ----
    const panel = new ChatViewProvider(context);
    out.appendLine("[activate] provider created");

    // ---- UI transcript (webview state restoration) ----
    // VS Code destroys a WebviewView's DOM whenever the view is hidden (e.g.
    // switching to another sidebar view) and re-runs resolveWebviewView when it
    // becomes visible again. There is no retainContextWhenHidden for views, so
    // everything the chat has shown is recorded here and replayed via
    // 'renderHistory' whenever the webview reports readiness. This also captures
    // output produced while the view was hidden.
    const uiLog: Array<{ role: string; text: string }> = [];
    let cachedModels: string[] = []; // last known model list, for instant restore

    /**
     * Post a chat message to the webview AND record it in uiLog so it can be
     * replayed after the webview is reloaded. Roles mirror the webview's
     * addMessage() roles: "user", "assistant", "tool", "error".
     */
    function recordAndPost(type: "delta" | "tool" | "error", text: string): void {
        uiLog.push({ role: type === "delta" ? "assistant" : type, text });
        panel.postMessage({ type, text });
    }

    // ---- Persisted prompt state: draft, input height, prompt history ----
    // Stored in workspaceState so it survives VS Code restarts, and mirrored
    // into the webview whenever the view is (re)created. The webview also keeps
    // its own copy via vscode.getState(); on webviewReady the freshest of the
    // two wins, and the extension-host copy acts as a fallback.
    const PROMPT_HISTORY_KEY = "aiAgentChat.promptHistory";
    const PROMPT_DRAFT_KEY = "aiAgentChat.promptDraft";
    const INPUT_HEIGHT_KEY = "aiAgentChat.inputHeight";
    const MAX_PROMPT_HISTORY = 500;

    let promptHistory: string[] = [];
    let currentDraft = "";
    let inputHeight = 0;

    try {
        const loadedHistory = context.workspaceState.get<string[]>(PROMPT_HISTORY_KEY, []);
        if (Array.isArray(loadedHistory)) {
            promptHistory = loadedHistory.filter((s) => typeof s === "string").slice(-MAX_PROMPT_HISTORY);
        }
        currentDraft = context.workspaceState.get<string>(PROMPT_DRAFT_KEY, "") || "";
        const storedHeight = context.workspaceState.get<number>(INPUT_HEIGHT_KEY, 0);
        if (typeof storedHeight === "number" && storedHeight > 0) {
            inputHeight = storedHeight;
        }
        out.appendLine("[activate] prompt history loaded: " + promptHistory.length + " entries" +
            (currentDraft ? " (draft present)" : "") +
            (inputHeight ? " (inputHeight=" + inputHeight + ")" : ""));
    } catch (e) {
        out.appendLine("[activate] prompt state load failed: " + String(e));
    }

    async function persistPromptState(): Promise<void> {
        try {
            await context.workspaceState.update(PROMPT_HISTORY_KEY, promptHistory.slice(-MAX_PROMPT_HISTORY));
            await context.workspaceState.update(PROMPT_DRAFT_KEY, currentDraft);
            await context.workspaceState.update(INPUT_HEIGHT_KEY, inputHeight);
        } catch (e) {
            out.appendLine("[state] persist prompt state failed: " + String(e));
        }
    }

    /** Append a submitted prompt to the persisted history (deduped, newest last). */
    function recordPrompt(text: string): void {
        if (!text) {
            return;
        }
        const dupIdx = promptHistory.indexOf(text);
        if (dupIdx !== -1) {
            promptHistory.splice(dupIdx, 1);
        }
        promptHistory.push(text);
        if (promptHistory.length > MAX_PROMPT_HISTORY) {
            promptHistory = promptHistory.slice(-MAX_PROMPT_HISTORY);
        }
    }

    // Register the setup message handler exactly once (not per welcome-screen show),
    // so the ⚙️ button works for returning users and handlers don't accumulate.
    registerSetupHandler(context, panel);

    context.subscriptions.push(
        vscode.commands.registerCommand("aiAgentChat.showWelcome", () => {
            showWelcomeScreen(context, panel);
        })
    );

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, panel)
    );
    out.appendLine("[activate] webview view provider registered");

    // Evaluate if the user is missing a required API key
    const hasKey = await getApiKey(context);
    const currentVersion = context.extension.packageJSON.version;
    const storedVersion = context.globalState.get<string>("aiAgentChat.version");

    if (currentVersion !== storedVersion || !hasKey) {
        void context.globalState.update("aiAgentChat.version", currentVersion);
        showWelcomeScreen(context, panel);
    }

    async function getEffectiveConfig(targetModel?: string) {
        const cfgNow = vscode.workspace.getConfiguration("aiAgentChat");
        const apiKey = await getApiKey(context);
        const baseUrl = (cfgNow.get<string>("baseUrl", "") || "").trim() || initialConfig.baseUrl;
        const model = targetModel || selectedModel || (cfgNow.get<string>("model", "") || "").trim() || initialConfig.model;
        return { apiKey, baseUrl, model };
    }

    async function fetchAndSendModels(targetModel?: string) {
        const effConfig = await getEffectiveConfig(targetModel);
        out.appendLine("[models] fetching available models from " + effConfig.baseUrl);
        try {
            const client = new ApiClient({
                ...effConfig,
                onRetry: (info) => out.appendLine("[chat] attempt " + info.attempt + "/" + info.maxAttempts +
                    " failed (" + info.error + "); retrying in " + info.delayMs + " ms"),
            });
            const models = await client.listModels();
            cachedModels = models; // remember for instant restore on webview reload
            out.appendLine("[models] fetched " + models.length + " models: " + models.join(", "));
            panel.postMessage({
                type: "modelsList",
                models: models,
                selected: effConfig.model
            });
        } catch (err: any) {
            out.appendLine("[models] failed to fetch models: " + String(err));
            // Keep the previous cachedModels (last known good) on failure.
            panel.postMessage({
                type: "modelsList",
                models: [effConfig.model],
                selected: effConfig.model,
                error: String(err)
            });
        }
    }

    async function benchmarkModels() {
        const effConfig = await getEffectiveConfig();
        let models: string[] = [];
        try {
            models = await new ApiClient({ ...effConfig, maxAttempts: 1 }).listModels();
        } catch (e) {
            out.appendLine("[timing] could not list models, falling back to current: " + String(e));
        }
        if (models.length === 0) {
            models = [effConfig.model];
        }

        const probe: ChatMessage[] = [{ role: "user", content: "ping" }];
        for (const model of models) {
            const started = Date.now();
            try {
                await new ApiClient({ ...effConfig, model }).chat(probe);
                const ms = Date.now() - started;
                out.appendLine("[timing] " + model + " = " + ms + " ms");
                panel.postMessage({ type: "modelTiming", model, ms });
            } catch (err: any) {
                out.appendLine("[timing] " + model + " FAILED after " + (Date.now() - started) + " ms: " + String(err));
                panel.postMessage({ type: "modelTiming", model, ms: -1 });
            }
        }
        panel.postMessage({ type: "benchmarkDone" });
    }

    async function performCompaction(): Promise<string> {
        if (history.length === 0) {
            return "Nothing to compact (history is empty).";
        }

        const effConfig = await getEffectiveConfig();
        if (!effConfig.apiKey) {
            throw new Error("API key is missing; cannot compact context.");
        }

        const originalCount = history.length;
        out.appendLine("[compact] compacting " + originalCount + " history messages");

        const transcript = history
            .map((m) => (m.role.toUpperCase() + ": " + (m.content ?? (m.tool_calls ? "[tool call]" : ""))))
            .join("\n\n");

        const client = new ApiClient({
            ...effConfig,
            onRetry: (info) => out.appendLine("[chat] attempt " + info.attempt + "/" + info.maxAttempts +
                " failed (" + info.error + "); retrying in " + info.delayMs + " ms"),
        });
        const summaryResp = await client.chat([
            {
                role: "system",
                content: "Summarize the following conversation concisely but completely: preserve key " +
                    "facts, decisions, file paths touched, and outstanding tasks. Write the summary as a " +
                    "short briefing for someone continuing the work, in plain prose (no meta-commentary)."
            },
            { role: "user", content: transcript },
        ]);
        const summaryText = summaryResp.content ?? "(no summary returned)";

        history.length = 0;
        history.push({ role: "assistant", content: summaryText });

        out.appendLine("[compact] history reduced from " + originalCount + " to 1 message");
        return "History compacted (" + originalCount + " → 1 message).\n\n" + summaryText;
    }

    async function compactHistory() {
        try {
            const result = await performCompaction();
            recordAndPost("tool", "compact_context → " + result);
        } catch (err: any) {
            out.appendLine("[compact] FAILED: " + String(err));
            recordAndPost("error", "Compact failed: " + String(err));
        }
        panel.postMessage({ type: "done", text: "" });
    }

    panel.onMessage(async (msg: any) => {
        if (!msg || typeof msg !== "object") {
            return;
        }
        if (msg.type === "webviewReady") {
            out.appendLine("[chat] webviewReady received, restoring chat state");
            // The webview restores its own persisted state (draft / input height)
            // before signaling readiness; adopt the freshest values it reports.
            if (typeof msg.draft === "string") {
                currentDraft = msg.draft;
            }
            if (typeof msg.height === "number" && msg.height > 0) {
                inputHeight = Math.round(msg.height);
            }
            // 1) Replay the transcript so the view looks exactly as it was left.
            if (uiLog.length > 0) {
                panel.postMessage({ type: "renderHistory", items: uiLog });
            }
            // 2) Restore the model dropdown instantly from the cached list.
            if (cachedModels.length > 0) {
                panel.postMessage({ type: "modelsList", models: cachedModels, selected: selectedModel });
            }
            // 3) If an agent run is still in flight, put the UI back into running mode.
            if (currentRun) {
                panel.postMessage({ type: "runState", running: true });
            }
            // 4) Restore prompt state: Up/Down history, plus draft and input
            //    height as a fallback when the webview's own state was lost.
            panel.postMessage({
                type: "promptState",
                draft: currentDraft,
                history: promptHistory,
                inputHeight: inputHeight
            });
            // 5) Then refresh models from the server as before.
            await fetchAndSendModels();
        } else if (msg.type === "draftChange" && typeof msg.text === "string") {
            // Mirror of the input draft (debounced by the webview) so the draft
            // survives webview disposal and window reloads.
            currentDraft = msg.text;
            void persistPromptState();
        } else if (msg.type === "inputHeightChange" && typeof msg.height === "number") {
            // Mirror of the user-resized input box height.
            inputHeight = Math.round(msg.height);
            void persistPromptState();
        } else if (msg.type === "fetchModels") {
            out.appendLine("[chat] fetchModels requested by user");
            await fetchAndSendModels();
        } else if (msg.type === "benchmarkModels") {
            out.appendLine("[chat] benchmarkModels requested by user");
            await benchmarkModels();
        } else if (msg.type === "compact") {
            out.appendLine("[chat] compact requested by user");
            await compactHistory();
        } else if (msg.type === "selectModel" && typeof msg.model === "string") {
            selectedModel = msg.model;
            out.appendLine("[chat] model selected: " + selectedModel);
        } else if (msg.type === "stop") {
            if (currentRun) {
                out.appendLine("[chat] stop requested by user");
                currentRun.abort();
            }
        }
    });

    panel.onUserMessage(async (text: string, modelFromWebview?: string) => {
        if (modelFromWebview) {
            selectedModel = modelFromWebview;
        }
        uiLog.push({ role: "user", text });
        // Record the prompt in the persisted Up/Down history (deduped, newest
        // last) and clear the draft mirror (the webview already cleared input).
        recordPrompt(text);
        currentDraft = "";
        void persistPromptState();
        // Keep the webview's Up/Down history in sync (it also appends locally
        // on submit for instant availability; this is the authoritative copy).
        panel.postMessage({ type: "promptHistory", items: promptHistory });
        out.appendLine("[chat] user message: " + text.substring(0, 80) + " (model: " + selectedModel + ")");

        let effConfig = await getEffectiveConfig(selectedModel);

        if (!effConfig.apiKey) {
            // Prompt user directly when key is missing
            const entered = await promptForApiKey(context);
            if (!entered) {
                recordAndPost(
                    "error",
                    "API key is required. Run 'AI Agent Chat: Set API Key' from the Command Palette or enter it when prompted."
                );
                return;
            }
            effConfig.apiKey = entered;
            await fetchAndSendModels();
        }

        const abortController = new AbortController();
        currentRun = abortController;
        try {
            const client = new ApiClient({
                ...effConfig,
                onRetry: (info) => out.appendLine("[chat] attempt " + info.attempt + "/" + info.maxAttempts +
                    " failed (" + info.error + "); retrying in " + info.delayMs + " ms"),
            });
            const userMsg: ChatMessage = { role: "user", content: text };
            const priorHistory = history.slice(-MAX_HISTORY);
            const cfgNow = vscode.workspace.getConfiguration("aiAgentChat");
            const rawMaxSteps = cfgNow.get<number>("maxSteps", 25);
            const maxSteps = Math.min(500, Math.max(1, Number(rawMaxSteps) || 25));

            const newMessages = await runAgent(client, priorHistory, userMsg, (delta: any) => {
                if (!delta || typeof delta !== "object") {
                    return;
                }
                if (delta.type === "assistant" && typeof delta.text === "string") {
                    recordAndPost("delta", delta.text);
                } else if (delta.type === "status" && typeof delta.text === "string") {
                    out.appendLine("[chat] " + delta.text);
                    if (delta.text.startsWith("[stopped:")) {
                        recordAndPost("error", delta.text);
                    }
                } else if (delta.type === "tool") {
                    recordAndPost("tool", (delta.name ? delta.name + " → " : "tool → ") + (delta.text ?? ""));
                }
            }, abortController.signal, {
                compactContext: async () => {
                    try {
                        return await performCompaction();
                    } catch (err: any) {
                        return "Error: " + String(err);
                    }
                },
            }, maxSteps);

            history.push(...newMessages);
            if (abortController.signal.aborted) {
                recordAndPost("error", "Stopped by user.");
            }
            panel.postMessage({ type: "done", text: "" });
            out.appendLine("[chat] agent run finished" + (abortController.signal.aborted ? " (stopped)" : ""));
        } catch (err: any) {
            if (abortController.signal.aborted) {
                out.appendLine("[chat] agent run stopped by user");
                recordAndPost("error", "Stopped by user.");
            } else {
                out.appendLine("[chat] agent run FAILED: " + String(err));
                recordAndPost("error", String(err));
            }
            panel.postMessage({ type: "done", text: "" });
        } finally {
            if (currentRun === abortController) {
                currentRun = undefined;
            }
        }
    });

    // ---- Secret change listener: refresh models if key is updated externally ----
    context.subscriptions.push(
        context.secrets.onDidChange(async (e) => {
            if (e.key === SECRET_KEY) {
                out.appendLine("[secrets] API key changed in SecretStorage");
                await fetchAndSendModels();
            }
        })
    );

    // ---- Command: Set API Key ----
    context.subscriptions.push(
        vscode.commands.registerCommand("aiAgentChat.setApiKey", async () => {
            await promptForApiKey(context);
        })
    );

    // ---- Command: Clear API Key ----
    context.subscriptions.push(
        vscode.commands.registerCommand("aiAgentChat.clearApiKey", async () => {
            await context.secrets.delete(SECRET_KEY);
            vscode.window.showInformationMessage("AI Agent Chat: API key cleared from SecretStorage.");
            out.appendLine("[secrets] API key deleted");
        })
    );

    // ---- Command: Focus Sidebar View ----
    context.subscriptions.push(
        vscode.commands.registerCommand("aiAgentChat.open", async () => {
            out.appendLine("[command] aiAgentChat.open");
            try {
                await vscode.commands.executeCommand(ChatViewProvider.viewId + ".focus");
            } catch (e) {
                out.appendLine("[command] focus FAILED: " + String(e));
                vscode.window.showErrorMessage("AI Agent Chat: could not open view: " + String(e));
            }
        })
    );

    // ---- Command: Diagnostics ----
    context.subscriptions.push(
        vscode.commands.registerCommand("aiAgentChat.diagnostics", () => {
            out.show(true);
            vscode.window.showInformationMessage("AI Agent Chat: diagnostics shown in output channel.");
        })
    );

    context.subscriptions.push(panel);
    context.subscriptions.push(out);
    out.appendLine("[activate] complete - all handlers registered");
}

export function deactivate() { }
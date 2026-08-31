import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { ChatViewProvider } from "./chatPanel";
import { runAgent } from "./agent";
import { ChatMessage, ApiClient } from "./apiClient";
import { type ToolContext } from "./tools";
import { parseMarkdownChecklist, type TodoItem } from "./tools/todos";
import {
    loadSession, saveSession, clearSession,
    stripToPersistableHistory, SESSION_VERSION, type SessionState,
    resolveContainedPath,
    createFolderMemoryStore, createGlobalMemoryStore, type MemoryStore,
} from "./persistence";
import { showWelcomeScreen, registerSetupHandler } from "./welcome";
import { processSlashCommand } from "./tools/commands/slash-commands";

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

    // ---- Workspace root + persistent memory file name ----
    // Both the session snapshot and the memory file live inside the workspace
    // root; persistence.ts contains all the path-containment logic.
    const wsRoot = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
        ? vscode.workspace.workspaceFolders[0].uri.fsPath
        : process.cwd();
    const getMemoryFile = (): string => {
        const cfg = vscode.workspace.getConfiguration("aiAgentChat");
        return (cfg.get<string>("memoryFile", "") || "").trim() || "AGENTS.md";
    };

    // ---- Global (cross-project) memory file name + storage directory ----
    // Unlike the folder memory (which lives inside the workspace), the GLOBAL
    // memory lives in the extension's machine-wide globalStorageUri, OUTSIDE
    // any workspace, so it is shared across every project on this machine
    // while each project keeps its own independent AGENTS.md. This is the
    // isolation boundary the user asked for: one project's memory never
    // leaks into another's. The file name is configurable via
    // `aiAgentChat.globalMemoryFile` (default GLOBAL_AGENTS.md).
    const getGlobalMemoryFile = (): string => {
        const cfg = vscode.workspace.getConfiguration("aiAgentChat");
        return (cfg.get<string>("globalMemoryFile", "") || "").trim() || "GLOBAL_AGENTS.md";
    };
    const globalMemoryDir = context.globalStorageUri
        ? context.globalStorageUri.fsPath
        : "";

    // ---- Conversation history & state ----
    const history: ChatMessage[] = [];
    // Session-level TODO list, surfaced to the model each turn via a reminder
    // block (see agent.ts) and mutated by the update_todo_list tool.
    let todoList: TodoItem[] = [];
    let selectedModel = initialConfig.model;
    let currentRun: AbortController | undefined;
    let activePromptResolver: ((value: string) => void) | undefined; 
    let activePromptCallId: string | undefined;
    // Disk-backed memory stores. Reads always hit disk (no cached snapshot), so
    // AGENTS.md / GLOBAL_AGENTS.md written by ANY path — a manual edit, the
    // /init slash command, or the update_memory tool — is picked up
    // immediately by both the system-prompt injection and the /config command.
    // Wiring the stores straight into the tool context (no adapter) keeps the
    // update_memory tool's observable behavior unchanged.
    const folderMemory: MemoryStore = createFolderMemoryStore(wsRoot, getMemoryFile);
    const globalMemory: MemoryStore = createGlobalMemoryStore(globalMemoryDir, getGlobalMemoryFile);

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

    // ---- Restore the durable session + memory on startup ----
    // The session snapshot (history/uiLog/todos/selectedModel) and the memory
    // file both live inside the workspace. We load them here so a window
    // reload/reopen resumes the conversation exactly where it left off. The
    // recovered uiLog is replayed into the webview once it signals readiness
    // (see the webviewReady handler), along with a small "restored" banner.
    let restoredFromSession = false;
    try {
        const session = loadSession(wsRoot);
        if (session) {
            if (Array.isArray(session.history) && session.history.length > 0) {
                history.push(...stripToPersistableHistory(session.history).slice(-MAX_HISTORY));
            }
            if (Array.isArray(session.uiLog) && session.uiLog.length > 0) {
                uiLog.push(...session.uiLog);
            }
            todoList = Array.isArray(session.todoList) ? session.todoList : [];
            if (session.selectedModel) {
                selectedModel = session.selectedModel;
            }
            restoredFromSession = true;
            out.appendLine("[activate] session restored: " + history.length + " history msgs, " +
                uiLog.length + " uiLog entries, " + todoList.length + " todos");
        } else {
            out.appendLine("[activate] no session found (fresh start)");
        }
    } catch (e) {
        out.appendLine("[activate] session restore failed: " + String(e));
    }

    // Eagerly read both memory scopes once at activation purely for the
    // startup diagnostic log — the stores below are disk-backed and re-read on
    // every access, so nothing is cached here. (Errors are non-fatal: get()
    // itself returns "" for a missing file.)
    try {
        out.appendLine("[activate] memory loaded (" + Buffer.byteLength(folderMemory.get(), "utf8") + " bytes)");
    } catch (e) {
        out.appendLine("[activate] memory load failed: " + String(e));
    }
    try {
        out.appendLine("[activate] global memory loaded (" + Buffer.byteLength(globalMemory.get(), "utf8") +
            " bytes) from " + (globalMemoryDir || "<no global storage>"));
    } catch (e) {
        out.appendLine("[activate] global memory load failed: " + String(e));
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

    /**
     * Snapshot the current conversation to the durable session file so it can be
     * resumed after a window reload/reopen. Called after each agent run and
     * after compaction. Only the API-replayable history is stored. Failures are
     * logged but never throw — a failed save must not kill the chat.
     */
    function persistSessionNow(): void {
        try {
            const session: SessionState = {
                version: SESSION_VERSION,
                history: stripToPersistableHistory(history.slice(-MAX_HISTORY)),
                uiLog: uiLog.slice(),
                todoList: todoList.slice(),
                selectedModel,
                savedAt: Date.now(),
            };
            const ok = saveSession(wsRoot, session);
            if (!ok) {
                out.appendLine("[session] save returned false (oversized or write failed)");
                recordAndPost("error", "Session too large to save. Compacting context automatically...");
                compactHistory();
            }
        } catch (e) {
            out.appendLine("[session] persist failed: " + String(e));
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

    /**
     * Expand `@path/to/file` mentions in a prompt by inlining the referenced
     * file's contents. The chat bubble keeps the original `@path` text (what
     * the user typed), but the model receives the expanded version so it can
     * act on the file without an extra round-trip.
     *
     * Only workspace-relative paths that resolve inside the workspace root are
     * inlined (resolveContainedPath rejects `../` escapes and absolute paths
     * outside the root). A mention whose file can't be read is left as-is with
     * a short note, so the model/user can see something went wrong.
     *
     * Mentions are tokenized greedily: `@` followed by run of non-space chars
     * that don't include newlines. This matches what the webview inserts via
     * insertFileRef() (`@path/to/file ` with a trailing space).
     */
    function expandFileMentions(prompt: string): string {
        if (!prompt || prompt.indexOf("@") === -1) {
            return prompt;
        }
        const mentionRe = /@([^\s@\n]+)/g;
        let result = "";
        let lastIndex = 0;
        let match: RegExpExecArray | null;
        let expandedAny = false;
        while ((match = mentionRe.exec(prompt)) !== null) {
            result += prompt.substring(lastIndex, match.index);
            const relPath = match[1];
            let abs: string;
            try {
                abs = resolveContainedPath(wsRoot, relPath);
            } catch {
                // Path escapes the workspace — leave the mention untouched.
                result += match[0];
                lastIndex = match.index + match[0].length;
                continue;
            }
            try {
                const content = fs.readFileSync(abs, "utf8");
                // Cap inlined content so a huge file can't blow out the prompt;
                // the agent can always read the full file with read_file.
                const MAX_INLINE = 20000;
                const trimmed = content.length > MAX_INLINE
                    ? content.substring(0, MAX_INLINE) + "\n…[truncated; use read_file for the full file]"
                    : content;
                result += "File `" + relPath + "`:\n```\n" + trimmed + "\n```";
                expandedAny = true;
            } catch {
                // Missing/unreadable file — keep the mention, add a note.
                result += match[0] + " (could not read file)";
            }
            lastIndex = match.index + match[0].length;
        }
        if (!expandedAny) {
            return prompt; // nothing to inline; return unchanged
        }
        result += prompt.substring(lastIndex);
        return result;
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
        // Compaction rewrote `history`; persist the compacted snapshot so a
        // reload doesn't resurrect the pre-compaction messages.
        persistSessionNow();
        panel.postMessage({ type: "done", text: "" });
    }

    /**
     * Ask the user to confirm clearing the conversation using a native VS Code
     * modal. Native window.confirm() is blocked inside the webview sandbox, so
     * the webview delegates the confirmation here. Returns true on confirm.
     */
    async function confirmClearChat(): Promise<boolean> {
        const choice = await vscode.window.showWarningMessage(
            "Clear the conversation? This deletes the saved session and cannot be undone.",
            { modal: true },
            "Clear"
        );
        return choice === "Clear";
    }

    /**
     * Clear the conversation and the durable session file. The long-term
     * memory file (AGENTS.md) is intentionally kept: it holds the agent's
     * cross-session understanding, not the current conversation. Used by both
     * the webview 🗑️ button and the command-palette entry.
     */
    function clearChat(): void {
        out.appendLine("[chat] clear chat requested");
        history.length = 0;
        uiLog.length = 0;
        todoList = [];
        restoredFromSession = false;
        try {
            clearSession(wsRoot);
        } catch (e) {
            out.appendLine("[session] clear failed: " + String(e));
        }
        // Tell the webview to drop its rendered bubbles and reset its UI state.
        panel.postMessage({ type: "clearChat" });
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
                // 1b) When the transcript was recovered from the durable session
                // (rather than just re-shown after a webview hide/show cycle),
                // surface a short notice so the user knows it is a resumed chat.
                if (restoredFromSession) {
                    const ts = new Date().toLocaleTimeString();
                    panel.postMessage({
                        type: "tool",
                        text: "restore → Resumed previous conversation from session (restored " +
                            history.length + " message(s) and " + todoList.length + " todo item(s)) at " + ts +
                            ". Folder memory: " + getMemoryFile() +
                            ". Global memory: " + getGlobalMemoryFile()
                    });
                    restoredFromSession = false; // only banner once per restore
                }
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
        } else if (msg.type === "clearChat") {
            // The webview cannot use window.confirm() (blocked by the sandbox),
            // so it requests the clear and the host shows a native modal.
            const ok = await confirmClearChat();
            if (!ok) {
                return;
            }
            clearChat();
        } else if (msg.type === "selectModel" && typeof msg.model === "string") {
            selectedModel = msg.model;
            out.appendLine("[chat] model selected: " + selectedModel);
        } else if (msg.type === "stop") {
            if (currentRun) {
                out.appendLine("[chat] stop requested by user");
                currentRun.abort();
            }
        } else if (msg.type === "requestOpenFiles") {
            // Collect the workspace-relative paths of every open text editor
            // tab so the webview's @-attach / [+] menu can offer them. Custom
            // editors, notebooks, webviews, etc. are skipped (only
            // TabInputText maps to a plain file URI we can safely mention).
            const openFiles: string[] = [];
            try {
                for (const tabGroup of vscode.window.tabGroups.all) {
                    for (const tab of tabGroup.tabs) {
                        if (tab.input instanceof vscode.TabInputText) {
                            const rel = path.relative(wsRoot, tab.input.uri.fsPath).replace(/\\/g, "/");
                            // Only mention files inside the workspace, and
                            // dedupe (the same file may be open in two groups).
                            if (rel && !rel.startsWith("..") && !path.isAbsolute(rel) && !openFiles.includes(rel)) {
                                openFiles.push(rel);
                            }
                        }
                    }
                }
            } catch (e: any) {
                out.appendLine("[files] collecting open files failed: " + String(e));
            }
            panel.postMessage({ type: "openFilesList", files: openFiles });
        } else if (msg.type === "browseFile") {
            // Launch VS Code's native open-file dialog, scoped to the workspace
            // root, and turn the chosen file into a workspace-relative @path
            // mention inserted into the prompt (files outside the workspace are
            // offered as absolute paths so the user still gets something usable).
            try {
                const uris = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    openLabel: "Attach File",
                    defaultUri: vscode.Uri.file(wsRoot),
                });
                if (uris && uris.length > 0) {
                    const chosen = uris[0].fsPath;
                    const rel = path.relative(wsRoot, chosen).replace(/\\/g, "/");
                    const mention = (rel && !rel.startsWith("..") && !path.isAbsolute(rel))
                        ? rel
                        : chosen.replace(/\\/g, "/");
                    panel.postMessage({ type: "insertFileMention", path: mention });
                }
            } catch (e: any) {
                out.appendLine("[files] open dialog failed: " + String(e));
            }
        } else if (msg.type === "quickPickSelected" || msg.type === "inputBoxSubmitted") {
            if (activePromptResolver && msg.callId === activePromptCallId) {
                const resolver = activePromptResolver;
                activePromptResolver = undefined;
                activePromptCallId = undefined;
                resolver(String(msg.value));
            }
        } else if (msg.type === "promptCancelled") {
            if (activePromptResolver && msg.callId === activePromptCallId) {
                const resolver = activePromptResolver;
                activePromptResolver = undefined;
                activePromptCallId = undefined;
                resolver("Error: User cancelled the prompt.");
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

        // ---- LOCAL SLASH COMMAND INTERCEPTION ----
        const slashCommandResult = await processSlashCommand(
            text,
            wsRoot,
            folderMemory,
            globalMemory,
            panel,
            recordAndPost,
            out,
            getMemoryFile,
            getGlobalMemoryFile,
            getEffectiveConfig,
            globalMemoryDir
        );

        // Handle slash command result:
        // - null: not a slash command, continue with agent
        // - "DONE": instant command handled locally, exit early
        // - other string: registry command, use modified text for agent
        if (slashCommandResult === "DONE") {
            return;
        }
        if (slashCommandResult !== null) {
            text = slashCommandResult;
        }
        // ------------------------------------------

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
            // Inline any @path/to/file mentions so the model sees the file
            // contents directly. The chat bubble already shows the original
            // text (pushed to uiLog above); only what's sent to the model is
            // expanded. Slash-command output is left untouched by this (it has
            // no @ mentions).
            const expandedText = expandFileMentions(text);
            if (expandedText !== text) {
                out.appendLine("[chat] expanded @ file mentions in prompt");
            }
            const userMsg: ChatMessage = { role: "user", content: expandedText };
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
                getTodoList: () => todoList,
                setTodoList: (t: TodoItem[]) => { todoList = t; },
                // Wire the disk-backed stores straight in: get() reads disk,
                // set() writes disk. No cached snapshot — external writes to
                // AGENTS.md / GLOBAL_AGENTS.md are reflected on the next get().
                getMemory: () => folderMemory.get(),
                setMemory: (content: string) => {
                    try {
                        folderMemory.set(content);
                    } catch (e: any) {
                        out.appendLine("[memory] save failed: " + String(e));
                    }
                },
                getGlobalMemory: () => globalMemory.get(),
                setGlobalMemory: (content: string) => {
                    try {
                        globalMemory.set(content);
                    } catch (e: any) {
                        out.appendLine("[memory] global save failed: " + String(e));
                    }
                },
                spawnSubTask: async (subMessage: string, subTodos?: string | null): Promise<string> => {
                    // Seed the child's todo list from the optional markdown checklist.
                    let childTodos: TodoItem[] = [];
                    if (subTodos) {
                        try {
                            childTodos = parseMarkdownChecklist(subTodos);
                        } catch {
                            childTodos = [];
                        }
                    }
                    const childContext: ToolContext = {
                        getTodoList: () => childTodos,
                        setTodoList: (t: TodoItem[]) => { childTodos = t; },
                        // Sub-tasks share the parent's disk-backed workspace
                        // memory: they read the accumulated understanding from
                        // disk and contribute to it via the same store.
                        getMemory: () => folderMemory.get(),
                        setMemory: (content: string) => {
                            try {
                                folderMemory.set(content);
                            } catch (e: any) {
                                out.appendLine("[memory] save failed: " + String(e));
                            }
                        },
                        // Sub-tasks also share the parent's GLOBAL (cross-project)
                        // memory, so they can read and contribute to it too.
                        getGlobalMemory: () => globalMemory.get(),
                        setGlobalMemory: (content: string) => {
                            try {
                                globalMemory.set(content);
                            } catch (e: any) {
                                out.appendLine("[memory] global save failed: " + String(e));
                            }
                        },
                        compactContext: async () => "Sub-task context compaction is not available.",
                        requestQuickPick: (placeHolder, options) => {
                            return new Promise<string>((resolve) => {
                                const callId = "qp_" + Math.random().toString(36).substring(2, 9);
                                activePromptResolver = resolve;
                                activePromptCallId = callId;
                                panel.postMessage({ type: "showQuickPickCard", callId, placeHolder, options });
                            });
                        },
                        requestInputBox: (prompt, placeHolder) => {
                            return new Promise<string>((resolve) => {
                                const callId = "ib_" + Math.random().toString(36).substring(2, 9);
                                activePromptResolver = resolve;
                                activePromptCallId = callId;
                                panel.postMessage({ type: "showInputBoxCard", callId, prompt, placeHolder });
                            });
                        },
                    };
                    const subUser: ChatMessage = { role: "user", content: subMessage };
                    const subMaxSteps = Math.max(1, maxSteps);
                    const subMessages = await runAgent(
                        client,
                        [],
                        subUser,
                        () => { /* child progress is surfaced via the parent tool result */ },
                        abortController.signal,
                        childContext,
                        subMaxSteps,
                    );
                    for (let i = subMessages.length - 1; i >= 0; i--) {
                        const m = subMessages[i];
                        if (m.role === "assistant" && m.content) {
                            return m.content;
                        }
                    }
                    return "(sub-task produced no final answer)";
                },
            }, maxSteps);

            history.push(...newMessages);
            if (abortController.signal.aborted) {
                recordAndPost("error", "Stopped by user.");
            }
            // Snapshot the (possibly updated) history/uiLog/todos/memory to the
            // durable session file so the conversation survives a reload.
            persistSessionNow();
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

    // ---- Command: Clear Chat ----
    context.subscriptions.push(
        vscode.commands.registerCommand("aiAgentChat.clearChat", async () => {
            const ok = await confirmClearChat();
            if (!ok) {
                return;
            }
            clearChat();
        })
    );

    context.subscriptions.push(panel);
    context.subscriptions.push(out);
    out.appendLine("[activate] complete - all handlers registered");
}

export function deactivate() { }
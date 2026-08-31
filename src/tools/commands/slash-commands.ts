import * as vscode from "vscode";
import { type MemoryStore } from "../../persistence";
import { type ChatViewProvider } from "../../chatPanel";
import { getCommand, getCommandNames } from "./commands";

/**
 * Process a slash command if the input starts with "/".
 * 
 * Returns:
 * - null: not a slash command, send to agent as-is
 * - "DONE": instant command handled locally (/config, /help, /memory), exit early
 * - string: modified prompt text for agent to process (e.g., registry command with injected content)
 * 
 * Instant commands (/config, /help, /memory) are processed locally.
 * Other commands are looked up in the registry and injected as agent tasks.
 */
export async function processSlashCommand(
    text: string,
    wsRoot: string,
    folderMemory: MemoryStore,
    globalMemory: MemoryStore,
    panel: ChatViewProvider,
    recordAndPost: (type: "delta" | "tool" | "error", text: string) => void,
    out: vscode.OutputChannel,
    getMemoryFile: () => string,
    getGlobalMemoryFile: () => string,
    getEffectiveConfig: (selectedModel?: string) => Promise<{ apiKey: string; baseUrl: string; model: string }>,
    globalMemoryDir: string
): Promise<string | null> {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) {
        return null;
    }

    const parts = trimmed.slice(1).split(/\s+/);
    const cmdName = parts[0].toLowerCase();
    const cmdArgs = parts.slice(1).join(" ");

    out.appendLine(`[slash-command] Attempting to execute: ${cmdName}`);

    // 1. Local /config command (instant response without calling the model)
    if (cmdName === "config") {
        const effConfig = await getEffectiveConfig();
        const cfgNow = vscode.workspace.getConfiguration("aiAgentChat");
        const folderBytes = Buffer.byteLength(folderMemory.get(), "utf8");
        const globalBytes = Buffer.byteLength(globalMemory.get(), "utf8");
        const globalStatus = globalMemoryDir
            ? `\`${getGlobalMemoryFile()}\` (${globalBytes} bytes)`
            : `*(global storage unavailable — file \`${getGlobalMemoryFile()}\`)*`;
        const configMsg = [
            "**Current Extension Configuration:**",
            `- **Base URL:** \`${effConfig.baseUrl}\``,
            `- **Model:** \`${effConfig.model}\``,
            `- **Max Steps:** \`${cfgNow.get<number>("maxSteps", 25)}\``,
            `- **API Key:** ${effConfig.apiKey ? "✅ Set" : "❌ Missing"}`,
            "",
            "**Memory (two scopes):**",
            `- **Folder memory** (project-specific, current workspace): \`${getMemoryFile()}\` — ${folderBytes} bytes`,
            `- **Global memory** (cross-project, shared across all workspaces): ${globalStatus}`,
            `- **Combined memory injected into prompt:** ${folderBytes + globalBytes} bytes`
        ].join("\n");

        recordAndPost("delta", configMsg);
        panel.postMessage({ type: "done", text: "" });
        return "DONE";
    }

    // 2. Local /help command (list all available commands)
    if (cmdName === "help") {
        try {
            const available = await getCommandNames(wsRoot);
            const helpLines: string[] = ["**Available Slash Commands:**", ""];

            // Fetch full command details for descriptions
            for (const name of available) {
                try {
                    const cmd = await getCommand(wsRoot, name);
                    if (cmd) {
                        const desc = cmd.description || "(no description)";
                        const hint = cmd.argumentHint ? ` *${cmd.argumentHint}*` : "";
                        helpLines.push(`- **\`/${name}\`**${hint} — ${desc}`);
                    } else {
                        helpLines.push(`- \`/${name}\``);
                    }
                } catch {
                    helpLines.push(`- \`/${name}\``);
                }
            }

            helpLines.push("", "Type `/<command>` to execute a command.");
            const helpMsg = helpLines.join("\n");
            recordAndPost("delta", helpMsg);
            panel.postMessage({ type: "done", text: "" });
            return "DONE";
        } catch (err: any) {
            out.appendLine(`[slash-command] Error in /help: ${err?.message ?? String(err)}`);
            recordAndPost("error", `Error listing commands: ${err?.message ?? String(err)}`);
            panel.postMessage({ type: "done", text: "" });
            return "DONE";
        }
    }

    // 3. Local /memory command (display memory file contents)
    if (cmdName === "memory") {
        try {
            const scope = cmdArgs?.toLowerCase() || "both";
            const memoryLines: string[] = ["**Memory Files:**", ""];

            if (scope === "both" || scope === "folder") {
                const folderMem = folderMemory.get();
                const folderBytes = Buffer.byteLength(folderMem, "utf8");
                const folderLinesCount = folderMem.split("\n").length;
                memoryLines.push(
                    `**Folder Memory** (${getMemoryFile()} - project-specific):`,
                    `- Size: ${folderBytes} bytes, ${folderLinesCount} lines`,
                    folderMem ? "```\n" + folderMem + "\n```" : "*(empty)*",
                    ""
                );
            }

            if (scope === "both" || scope === "global") {
                const globalMem = globalMemory.get();
                const globalBytes = Buffer.byteLength(globalMem, "utf8");
                const globalLinesCount = globalMem.split("\n").length;
                memoryLines.push(
                    `**Global Memory** (${getGlobalMemoryFile()} - cross-project):`,
                    `- Size: ${globalBytes} bytes, ${globalLinesCount} lines`,
                    globalMem ? "```\n" + globalMem + "\n```" : "*(empty)*"
                );
            }

            recordAndPost("delta", memoryLines.join("\n"));
            panel.postMessage({ type: "done", text: "" });
            return "DONE";
        } catch (err: any) {
            out.appendLine(`[slash-command] Error in /memory: ${err?.message ?? String(err)}`);
            recordAndPost("error", `Error reading memory: ${err?.message ?? String(err)}`);
            panel.postMessage({ type: "done", text: "" });
            return "DONE";
        }
    }

    // 4. Lookup other commands in registry (project > global > built-in)
    // These will be sent to the agent as tasks
    try {
        const command = await getCommand(wsRoot, cmdName);
        if (!command) {
            out.appendLine(`[slash-command] Command not found: ${cmdName}`);
            const available = await getCommandNames(wsRoot);
            out.appendLine(`[slash-command] Available commands: ${available.join(", ")}`);
            const notFoundMsg = `Command \`/${cmdName}\` not found.\n\n**Available commands:** ${available.length ? available.map((c) => `\`/${c}\``).join(", ") : "(none)"
                }`;
            recordAndPost("error", notFoundMsg);
            panel.postMessage({ type: "done", text: "" });
            return "DONE";
        }

        out.appendLine(`[slash-command] Found command: ${cmdName}`);

        // Return modified prompt with injected command content for agent to process
        let promptText = `Execute slash command /${command.name}:\n\n${command.content}`;
        if (cmdArgs) {
            promptText += `\n\nArguments provided:\n${cmdArgs}`;
        }
        return promptText;
    } catch (err: any) {
        out.appendLine(`[slash-command] Error looking up command ${cmdName}: ${err?.message ?? String(err)}`);
        const errorMsg = `Error executing slash command \`/${cmdName}\`: ${err?.message ?? String(err)}`;
        recordAndPost("error", errorMsg);
        panel.postMessage({ type: "done", text: "" });
        return "DONE";
    }
}

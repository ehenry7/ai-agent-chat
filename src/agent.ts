import { ApiClient, ChatMessage } from "./apiClient";
import { tools, executeTool, ToolContext } from "./tools";

/** Tool names that only read/query state; safe to run concurrently. Exported for tests. */
export const READONLY_TOOLS = new Set([
  "read_file",
  "read_file_lines",
  "list_directory",
  "search_in_files",
  "find_files",
  "git_status",
  "git_log",
  "fetch_url",
  "web_search",
  "get_diagnostics",
  "get_active_editor",
]);

/** Pure system-prompt builder, exported for unit testing (no vscode dependency). */
export function buildSystemPrompt(toolNames: string[], platform: NodeJS.Platform): string {
  const shell = platform === "win32" ? "powershell.exe" : "bash";
  return (
    "You are a coding agent working inside a VS Code workspace. " +
    `The host OS is "${platform}" (run_command executes via ${shell}). ` +
    `Use the provided tools (${toolNames.join(", ")}) to explore, read, write, and run commands as needed. ` +
    "Every tool call's arguments must be one valid JSON object: quote every property name and string value with double quotes, " +
    "never use bare file paths, and use only the properties in that tool's schema. For search_in_files, limit a search with \"glob\", not \"path\". " +
    "Prefer edit_file over write_file for targeted changes to existing files, prefer find_files/" +
    "list_directory/search_in_files over shell commands like find/grep/ls for file discovery and " +
    "text search \u2014 they work identically across platforms, unlike Unix shell utilities on Windows. " +
    "If the conversation has grown very long and you're at risk of running out of context, call " +
    "compact_context to summarize and free up space before continuing."
  );
}

export function parseToolArguments(rawArguments: unknown): Record<string, unknown> {
  if (rawArguments === undefined || rawArguments === null || rawArguments === "") {
    return {};
  }
  if (typeof rawArguments === "object" && !Array.isArray(rawArguments)) {
    return rawArguments as Record<string, unknown>;
  }
  if (typeof rawArguments !== "string") {
    throw new Error("arguments must be a JSON object");
  }

  const parsed = JSON.parse(rawArguments);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("arguments must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export async function runAgent(
  client: ApiClient,
  history: ChatMessage[],
  userMessage: ChatMessage,
  onDelta: (msg: any) => void,
  signal?: AbortSignal,
  toolContext?: ToolContext,
  maxSteps = 15
): Promise<ChatMessage[]> {
  const system: ChatMessage = {
    role: "system",
    content: buildSystemPrompt(tools.map((t) => t.function.name), process.platform),
  };

  const messages: ChatMessage[] = [system, ...history, userMessage];
  const newMessages: ChatMessage[] = [userMessage];
  let finished = false;

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) {
      onDelta({ type: "status", text: "[stopped by user]" });
      finished = true;
      break;
    }
    onDelta({ type: "status", text: `[step ${step + 1}/${maxSteps}]` });

    const assistant = await client.chat(messages, tools, signal);
    newMessages.push(assistant);

    if (assistant.tool_calls && assistant.tool_calls.length > 0) {
      onDelta({ type: "assistant", text: assistant.content ?? "" });
      messages.push(assistant);

      const calls = assistant.tool_calls;
      const results: (string | undefined)[] = new Array(calls.length);

      const runOne = async (i: number): Promise<string> => {
        const call = calls[i];
        try {
          const args = parseToolArguments(call.function.arguments);
          return await executeTool(call.function.name, args, toolContext);
        } catch (e: any) {
          if (e instanceof SyntaxError || e?.message === "arguments must be a JSON object") {
            return `Tool ${call.function.name} was not run: its arguments were not valid JSON. ` +
              "Retry the tool with exactly one JSON object, using double quotes around all keys and string values, " +
              "and only fields declared in its schema.";
          }
          return `Error executing tool: ${e?.message ?? String(e)}`;
        }
      };

      if (!signal?.aborted) {
        const readonlyIdx: number[] = [];
        const mutatingIdx: number[] = [];
        calls.forEach((call, i) => {
          (READONLY_TOOLS.has(call.function.name) ? readonlyIdx : mutatingIdx).push(i);
        });

        // Read-only calls have no side effects on each other, so run them concurrently.
        await Promise.all(readonlyIdx.map(async (i) => { results[i] = await runOne(i); }));

        // Mutating calls run one at a time, honoring a mid-batch stop request.
        for (const i of mutatingIdx) {
          if (signal?.aborted) {
            break;
          }
          results[i] = await runOne(i);
        }
      }

      // Reassemble tool response messages in the original call order (required by the API).
      for (let i = 0; i < calls.length; i++) {
        const call = calls[i];
        if (results[i] === undefined) {
          onDelta({ type: "status", text: "[stopped by user]" });
          finished = true;
          break;
        }
        const result = results[i] as string;
        onDelta({ type: "tool", name: call.function.name, text: result });

        const toolMsg: ChatMessage = {
          role: "tool",
          tool_call_id: call.id,
          content: result,
        };
        messages.push(toolMsg);
        newMessages.push(toolMsg);
      }
      continue; // loop again so the model sees the tool results
    }

    // Final answer.
    if (!assistant.content) {
      onDelta({ type: "status", text: "[stopped: model returned an empty response with no tool calls]" });
    }
    onDelta({ type: "assistant", text: assistant.content ?? "" });
    finished = true;
    break;
  }

  if (!finished) {
    onDelta({
      type: "status",
      text: `[stopped: reached max steps (${maxSteps}) while tool calls were still pending]`,
    });
  }

  return newMessages;
}


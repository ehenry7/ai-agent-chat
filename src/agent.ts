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

/**
 * Truncates a tool result to at most `maxBytes` UTF-8 bytes, cutting at a valid
 * character boundary (never splitting a multi-byte sequence), and appends a
 * marker noting how much was cut. Passthrough if already under the limit.
 * Exported for unit testing.
 */
export function truncateResult(text: string, maxBytes = 8192): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) {
    return text;
  }

  const origBytes = buf.length;
  const origLines = text.split("\n").length;

  // Back off to the start of the (possibly incomplete) character at the cut point.
  let start = maxBytes;
  while (start > 0 && (buf[start] & 0xc0) === 0x80) {
    start--;
  }
  let end = maxBytes;
  const firstByte = buf[start];
  let charLen = 1;
  if ((firstByte & 0xe0) === 0xc0) {
    charLen = 2;
  } else if ((firstByte & 0xf0) === 0xe0) {
    charLen = 3;
  } else if ((firstByte & 0xf8) === 0xf0) {
    charLen = 4;
  }
  if (start + charLen > maxBytes) {
    end = start; // the character at the boundary is incomplete; drop it
  }

  const kept = buf.subarray(0, end);
  const marker = `\n\u2026[truncated: ${origBytes} bytes, ${origLines} lines \u2192 kept ${kept.length} bytes]`;
  return kept.toString("utf8") + marker;
}

/** Pure system-prompt builder, exported for unit testing (no vscode dependency). */
export function buildSystemPrompt(toolNames: string[], platform: NodeJS.Platform): string {
  const shell = platform === "win32" ? "powershell.exe" : "bash";
  return (
    "You are a coding agent working inside a VS Code workspace. " +
    `The host OS is "${platform}" (run_command executes via ${shell}). ` +
    `Use the provided tools (${toolNames.join(", ")}) to explore, read, write, and run commands as needed. ` +
    "Prefer edit_file over write_file for targeted changes to existing files, prefer find_files/" +
    "list_directory/search_in_files over shell commands like find/grep/ls for file discovery and " +
    "text search \u2014 they work identically across platforms, unlike Unix shell utilities on Windows. " +
    "If the conversation has grown very long and you're at risk of running out of context, call " +
    "compact_context to summarize and free up space before continuing."
  );
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

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) {
      onDelta({ type: "status", text: "[stopped by user]" });
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
          const args = JSON.parse(call.function.arguments || "{}");
          return await executeTool(call.function.name, args, toolContext);
        } catch (e: any) {
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
          break;
        }
        const result = results[i] as string;
        onDelta({ type: "tool", name: call.function.name, text: result });

        const toolMsg: ChatMessage = {
          role: "tool",
          tool_call_id: call.id,
          content: truncateResult(result),
        };
        messages.push(toolMsg);
        newMessages.push(toolMsg);
      }
      continue; // loop again so the model sees the tool results
    }

    // Final answer.
    onDelta({ type: "assistant", text: assistant.content ?? "" });
    break;
  }

  return newMessages;
}


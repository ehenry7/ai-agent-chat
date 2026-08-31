import { ApiClient, ChatMessage } from "./apiClient";
import { tools, executeTool, ToolContext } from "./tools";
import { formatReminderSection } from "./tools/todos";
import { buildMemoryPrompt, buildGlobalMemoryPrompt } from "./persistence";

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
 * Pure system-prompt builder, exported for unit testing (no vscode dependency).
 *
 * `memory` is the agent's persistent FOLDER (per-workspace) memory contents
 * (AGENTS.md); when non-empty it is appended to the system prompt inside an
 * `<agent_memory>` block (see {@link buildMemoryPrompt}).
 *
 * `globalMemory` is the agent's GLOBAL (cross-project) memory contents; when
 * non-empty it is appended inside an `<agent_global_memory>` block (see
 * {@link buildGlobalMemoryPrompt}). Global memory is injected FIRST (it is the
 * more general context), and folder memory is injected LAST (it is the more
 * specific, project-scoped context and therefore the freshest in the prompt).
 *
 * Both are optional and trailing, so existing two- and three-argument callers
 * keep working unchanged (the 4th argument defaults to no global memory).
 *
 * Pure system-prompt builder, exported for unit testing (no vscode dependency).
 */
export function buildSystemPrompt(
  toolNames: string[],
  platform: NodeJS.Platform,
  memory?: string,
  globalMemory?: string,
  currentPhase: "discovery" | "execution" = "discovery"
): string {
  const shell = platform === "win32" ? "powershell.exe" : "bash";
  return (
    "You are an autonomous coding agent working inside a VS Code workspace. " +
    `The host OS is "${platform}" (run_command executes via ${shell}). prefer using run_python tool over shell. ` +
    `Available tools: ${toolNames.join(", ")}. ` +
    `IMPORTANT: You are currently in the '${currentPhase}' phase. In 'discovery', you only have read-only tools to explore the codebase. Once you understand the task and are ready to make changes, use the 'request_phase_change' tool to unlock mutation tools (write_file, run_command, etc). ` +
    "For complex tasks, output a <plan> block with a numbered list of steps before executing tools. Track and update your progress using the 'update_plan' tool. " +
    "Every tool call's arguments must be one valid JSON object: quote every property name and string value with double quotes, " +
    "never use bare file paths, and use only the properties in that tool's schema. " +
    "If the conversation has grown very long, call compact_context to summarize and free up space before continuing." +
    buildGlobalMemoryPrompt(globalMemory ?? "") +
    buildMemoryPrompt(memory ?? "")
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

// ---- Semantic Sliding Window (context preservation for long conversations) ----

/**
 * Number of most-recent messages always kept intact by the Semantic Sliding
 * Window. The system prompt (index 0) is protected on top of this, so in a
 * conversation of length N the protected region is index 0 plus the last
 * {@link RECENT_WINDOW_MESSAGES} entries; only the older middle can be
 * compressed. Exported for unit testing.
 */
export const RECENT_WINDOW_MESSAGES = 8;

/**
 * A tool-result body is considered "massive" (worth compressing once it has
 * aged out of the recent window) when it exceeds this many characters. Smaller
 * outputs (typical confirmations like "Deleted x" or "Wrote N bytes") cost
 * almost nothing and double as a compact audit trail, so they are left intact.
 * Exported for unit testing.
 */
export const TOOL_COMPRESS_THRESHOLD = 2000;

/** Placeholder substituted for an old, massive tool-result body. */
export const COMPRESSED_TOOL_NOTICE =
  "[Tool executed successfully. Output compressed for memory preservation.]";

/**
 * Semantic Sliding Window: build a context-preserving VIEW of the message
 * history for an API call.
 *
 *   - Index 0 (the system prompt) is always kept intact.
 *   - The most recent {@link RECENT_WINDOW_MESSAGES} messages are kept intact
 *     (this is the agent's active working context).
 *   - Any OLDER message whose `role === "tool"` and whose body is "massive"
 *     (longer than {@link TOOL_COMPRESS_THRESHOLD}) has its `content` replaced
 *     with {@link COMPRESSED_TOOL_NOTICE}; `role` and `tool_call_id` are
 *     preserved so the message still pairs with its preceding tool_call for the
 *     API. Smaller old tool outputs and all non-tool messages are left as-is.
 *
 * This is the second line of defense for the context window (the first being
 * the Per-Tool Truncation Budget in tools.ts#truncateToolOutput). It returns a
 * NEW array and never mutates the input, so the caller's real history (and the
 * persisted session) keep full tool output — only the array sent to the model
 * is compressed. Pure (no vscode dependency), exported for unit testing.
 */
export function applySemanticSlidingWindow(
  messages: ChatMessage[],
  options?: { recentWindow?: number; compressThreshold?: number },
): ChatMessage[] {
  const recentWindow = options?.recentWindow ?? RECENT_WINDOW_MESSAGES;
  const threshold = options?.compressThreshold ?? TOOL_COMPRESS_THRESHOLD;
  const n = messages.length;

  // Index 0 (system) + the recent window together. Everything strictly between
  // them is eligible for compression.
  const protectedStart = Math.max(1, n - recentWindow);

  const out: ChatMessage[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const m = messages[i];
    if (i === 0 || i >= protectedStart) {
      // System prompt and recent window: keep intact.
      out[i] = m;
    } else if (
      m.role === "tool" &&
      typeof m.content === "string" &&
      m.content.length > threshold
    ) {
      // Old, massive tool result: compress the body, keep the envelope.
      out[i] = { ...m, content: COMPRESSED_TOOL_NOTICE };
    } else {
      out[i] = m;
    }
  }
  return out;
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
  const memory = toolContext?.getMemory?.() ?? "";
  const globalMemory = toolContext?.getGlobalMemory?.() ?? "";
  
  // Agent State Variables
  let currentPlan: string | null = null;
  let currentPhase: "discovery" | "execution" = "discovery" as "discovery" | "execution";
  let pendingReflection = false;
  let currentMaxSteps = maxSteps;

  const MUTATING_TOOLS = new Set([
    "write_file", "edit_file", "apply_patch", "apply_diff", 
    "search_replace", "delete_file", "delete_directory", 
    "rename_file", "create_directory", "run_command", 
    "run_python", "git_commit"
  ]);

  const messages: ChatMessage[] = [
    { role: "system", content: "" }, // Placeholder, rebuilt every step
    ...history, 
    userMessage
  ];
  const newMessages: ChatMessage[] = [userMessage];
  let finished = false;

  for (let step = 0; step < currentMaxSteps; step++) {
    if (signal?.aborted) {
      onDelta({ type: "status", text: "[stopped by user]" });
      finished = true;
      break;
    }
    onDelta({ type: "status", text: `[step ${step + 1}/${currentMaxSteps}]` });

    // 1. Dynamic Tool Filtering based on phase
    const activeTools: typeof tools = currentPhase === "execution" 
      ? tools 
      : (tools.filter(t => !MUTATING_TOOLS.has(t.function.name)) as typeof tools);    
    
    // 2. Rebuild System Prompt for this turn
    messages[0].content = buildSystemPrompt(
      activeTools.map((t) => t.function.name), 
      process.platform, 
      memory, 
      globalMemory,
      currentPhase
    );

    // 3. Ephemeral Context Injection (Reminders, Plans, Reflections)
    const ephemeralMessages: ChatMessage[] = [];
    
    if (currentPlan) {
      ephemeralMessages.push({ 
        role: "system", 
        content: `Current Plan State (Step ${step + 1}/${currentMaxSteps}):\n${currentPlan}` 
      });
    }

    if (pendingReflection) {
      ephemeralMessages.push({ 
        role: "system", 
        content: `System: Mutating action completed. Output a <reflection> block assessing if the output matches your expected outcome before proceeding to your next step.` 
      });
    }

    const todoList = toolContext?.getTodoList?.();
    const reminder = todoList && todoList.length > 0 ? formatReminderSection(todoList) : "";
    if (reminder) {
      ephemeralMessages.push({ role: "user", content: reminder });
    }

    const compressedView = applySemanticSlidingWindow(messages);
    const messagesForApi: ChatMessage[] = [...compressedView, ...ephemeralMessages];

    // 4. Call Model
    const assistant = await client.chat(messagesForApi, activeTools, signal);
    newMessages.push(assistant);

    // 5. Parse Reflection & Plan blocks from response
    if (assistant.content) {
      const planMatch = assistant.content.match(/<plan>([\s\S]*?)<\/plan>/i);
      if (planMatch) currentPlan = planMatch[1].trim();

      if (pendingReflection) {
        const reflMatch = assistant.content.match(/<reflection>([\s\S]*?)<\/reflection>/i);
        if (reflMatch && reflMatch[1].match(/(failed|error|incorrect|revert|fix|wrong)/i)) {
          currentMaxSteps += 2; // Grant grace steps to recover from the failure
          onDelta({ type: "status", text: "[self-correction detected: +2 grace steps]" });
        }
        pendingReflection = false; // Consume reflection request
      }
    }

    if (assistant.tool_calls && assistant.tool_calls.length > 0) {
      onDelta({ type: "assistant", text: assistant.content ?? "" });
      messages.push(assistant);

      const calls = assistant.tool_calls;
      const results: (string | undefined)[] = new Array(calls.length);

      const runOne = async (i: number): Promise<string> => {
        const call = calls[i];
        try {
          if (call.function.name === "new_task" && calls.length > 1) {
            return "Error: new_task MUST be called alone.";
          }
          
          const args = parseToolArguments(call.function.arguments);

          // Intercept state-control tools directly
          if (call.function.name === "update_plan") {
            currentPlan = args.updated_plan ? String(args.updated_plan) : currentPlan;
            return `Plan successfully updated.`;
          }
          if (call.function.name === "request_phase_change") {
            if (args.target_phase === "execution") {
              currentPhase = "execution";
              return "Phase changed to 'execution'. Mutation tools are now unlocked for the next turn.";
            } else {
              currentPhase = "discovery";
              return "Phase changed to 'discovery'.";
            }
          }

          // Flag for reflection if a mutation tool is about to be executed
          if (MUTATING_TOOLS.has(call.function.name)) {
            pendingReflection = true;
          }

          return await executeTool(call.function.name, args, toolContext);
        } catch (e: any) {
          if (e instanceof SyntaxError || e?.message === "arguments must be a JSON object") {
            return `Tool ${call.function.name} was not run: its arguments were not valid JSON. ` +
              "Retry the tool with exactly one JSON object.";
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

        await Promise.all(readonlyIdx.map(async (i) => { results[i] = await runOne(i); }));

        for (const i of mutatingIdx) {
          if (signal?.aborted) break;
          results[i] = await runOne(i);
        }
      }

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
      continue; 
    }

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
      text: `[stopped: reached max steps (${currentMaxSteps}) while tool calls were still pending]`,
    });
  }

  return newMessages;
}

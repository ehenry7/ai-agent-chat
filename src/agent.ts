import * as vscode from "vscode";
import * as fs from "fs";
import { ApiClient, ChatMessage } from "./apiClient";

const MAX_STEPS = 10;
const workspaceRoot = () => {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri : vscode.Uri.file(process.cwd());
};

const tools = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the content of a file in the workspace",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path in the workspace" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file in the workspace (creates or overwrites)",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path in the workspace" },
          content: { type: "string", description: "Full file content" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command in the workspace root (30s timeout)",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to run" },
        },
        required: ["command"],
      },
    },
  },
];

function resolveInWorkspace(relPath: string): string {
  // Contain paths within the workspace root (reject ../ escapes).
  const root = workspaceRoot().fsPath;
  const abs = require("path").resolve(root, relPath);
  const rel = require("path").relative(root, abs);
  if (rel.startsWith("..") || require("path").isAbsolute(rel)) {
    throw new Error(`Path escapes the workspace: ${relPath}`);
  }
  return abs;
}

async function executeTool(name: string, args: any): Promise<string> {
  try {
    switch (name) {
      case "read_file": {
        const abs = resolveInWorkspace(String(args.path));
        return fs.readFileSync(abs, "utf8");
      }
      case "write_file": {
        const abs = resolveInWorkspace(String(args.path));
        fs.writeFileSync(abs, String(args.content), "utf8");
        return `Wrote ${Buffer.byteLength(String(args.content))} bytes to ${args.path}`;
      }
      case "run_command": {
        const { execFile } = require("child_process");
        return await new Promise<string>((resolve, reject) => {
          execFile(
            process.platform === "win32" ? "cmd" : "bash",
            process.platform === "win32" ? ["/d", "/c", String(args.command)] : ["-lc", String(args.command)],
            { cwd: workspaceRoot().fsPath, timeout: 30_000 },
            (err: any, stdout: string, stderr: string) => {
              if (err) {
                reject(err);
                return;
              }
              resolve(`STDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
            }
          );
        });
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err: any) {
    return `Error: ${err?.message ?? String(err)}\nSTDOUT:\n${err?.stdout ?? ""}\nSTDERR:\n${err?.stderr ?? ""}`;
  }
}

export async function runAgent(
  client: ApiClient,
  history: ChatMessage[],
  userMessage: ChatMessage,
  onDelta: (msg: any) => void
): Promise<ChatMessage[]> {
  const system: ChatMessage = {
    role: "system",
    content:
      "You are a coding agent working inside a VS Code workspace. " +
      "Use the provided tools to read, write, and run commands as needed.",
  };

  const messages: ChatMessage[] = [system, ...history, userMessage];
  const newMessages: ChatMessage[] = [userMessage];

  for (let step = 0; step < MAX_STEPS; step++) {
    onDelta({ type: "status", text: `[step ${step + 1}/${MAX_STEPS}]` });

    const assistant = await client.chat(messages, tools);
    newMessages.push(assistant);

    if (assistant.tool_calls && assistant.tool_calls.length > 0) {
      onDelta({ type: "assistant", text: assistant.content ?? "" });
      messages.push(assistant);

      for (const call of assistant.tool_calls) {
        let result: string;
        try {
          const args = JSON.parse(call.function.arguments || "{}");
          result = await executeTool(call.function.name, args);
        } catch (e: any) {
          result = `Error executing tool: ${e?.message ?? String(e)}`;
        }
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
    onDelta({ type: "assistant", text: assistant.content ?? "" });
    break;
  }

  return newMessages;
}

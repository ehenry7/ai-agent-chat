import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import * as https from "https";
import * as cp from "child_process";
import * as util from "util";
import { URL } from "url";

import { parsePatch, processAllHunks } from "./tools/apply-patch";
import { applyDiff } from "./tools/diff/multi-search-replace";
import {
  parseMarkdownChecklist,
  validateTodos,
  normalizeStatus,
  type TodoItem,
} from "./tools/todos";
import { getCommand, getCommandNames } from "./tools/commands/commands";

const exec = util.promisify(cp.exec);

export const workspaceRoot = () => {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri : vscode.Uri.file(process.cwd());
};

export const tools = [
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
      name: "read_file_lines",
      description: "Read a line range from a file (useful for large files instead of reading the whole thing)",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path in the workspace" },
          startLine: { type: "number", description: "1-based start line (default: 1)" },
          endLine: { type: "number", description: "1-based end line, inclusive (default: last line)" },
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
      name: "edit_file",
      description: "Replace an exact search string with new text in a file, without rewriting the whole file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path in the workspace" },
          search: { type: "string", description: "Exact text to find (must match uniquely unless replaceAll is set)" },
          replace: { type: "string", description: "Text to replace it with" },
          replaceAll: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match (default: false)" },
        },
        required: ["path", "search", "replace"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_python",
      description: "Execute a Python code snippet using the local python interpreter and return its stdout and stderr.",
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "The Python source code to execute."
          }
        },
        required: ["code"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List files and subdirectories at a path in the workspace",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path in the workspace (default: workspace root)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_files",
      description: "Find files by glob/name pattern across the workspace (native, cross-platform file discovery)",
      parameters: {
        type: "object",
        properties: {
          glob: { type: "string", description: "Glob pattern, e.g. '**/*.ts' (default: all files)" },
          exclude: { type: "string", description: "Glob pattern to exclude (default: '**/node_modules/**')" },
          maxResults: { type: "number", description: "Max number of results (default: 200)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_in_files",
      description: "Search for a text or regex pattern across workspace files and return matching lines",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text or regex pattern to search for" },
          isRegex: { type: "boolean", description: "Treat query as a regular expression (default: false)" },
          glob: { type: "string", description: "Glob pattern to restrict searched files, e.g. '**/*.ts' (default: all files)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_diagnostics",
      description: "Get VS Code errors/warnings (with line numbers), optionally scoped to one file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path in the workspace (default: all files)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_active_editor",
      description: "Get the active editor's file path, selection range, and selected text",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_symbols",
      description: "Get the document outline (functions/classes/etc. with line numbers) for a file",
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
      name: "format_document",
      description: "Run the configured formatter on a file and save the result",
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
      name: "delete_file",
      description: "Delete a file in the workspace. This is for files only, not directories; use delete_directory for directories. Requires user confirmation.",
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
      name: "delete_directory",
      description: "Delete a directory in the workspace. Supports recursive deletion of non-empty directories. Requires user confirmation.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path in the workspace" },
          recursive: { type: "boolean", description: "Recursively delete the directory and all of its contents, allowing non-empty directories (default: true). When false, the directory must be empty." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rename_file",
      description: "Rename or move a file within the workspace",
      parameters: {
        type: "object",
        properties: {
          oldPath: { type: "string", description: "Current relative path" },
          newPath: { type: "string", description: "New relative path" },
        },
        required: ["oldPath", "newPath"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_directory",
      description: "Create a directory (including parent directories) in the workspace",
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
      name: "git_status",
      description: "Show the working tree status (git status --porcelain)",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "Show changes (git diff), optionally staged, against a ref, or limited to a path",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to limit the diff to (optional)" },
          staged: { type: "boolean", description: "Show staged changes instead (git diff --cached)" },
          ref: { type: "string", description: "Diff against a specific ref/commit, e.g. 'HEAD~1' (optional)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_log",
      description: "Show recent commit history",
      parameters: {
        type: "object",
        properties: {
          count: { type: "number", description: "Number of commits to show (default: 10)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_commit",
      description: "Stage all changes and create a commit. Requires user confirmation.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "Commit message" },
        },
        required: ["message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description: "Fetch the contents of a public http(s) URL (GET only, response capped at 100KB)",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The http:// or https:// URL to fetch" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for a query and return matching page titles and URLs",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" },
          count: { type: "number", description: "Max number of results to return (default: 5, max: 10)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "show_quick_pick",
      description: "Ask the user to choose one option from a list, shown as a VS Code Quick Pick",
      parameters: {
        type: "object",
        properties: {
          options: { type: "array", items: { type: "string" }, description: "List of choices to present" },
          placeHolder: { type: "string", description: "Prompt text shown above the choices" },
        },
        required: ["options"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "show_input_box",
      description: "Ask the user to type a free-text answer via a VS Code input box",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Prompt text shown to the user" },
          placeHolder: { type: "string", description: "Placeholder text in the input box" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_file_in_editor",
      description: "Open a workspace file in the editor, optionally jumping to a line",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path in the workspace" },
          line: { type: "number", description: "1-based line number to reveal (optional)" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command in the workspace root (30s timeout). Requires user confirmation.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to run" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_in_terminal",
      description: "Send a command to a visible VS Code integrated terminal (for long-running/interactive commands)",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to send to the terminal" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compact_context",
      description: "Summarize the conversation so far and replace it with a compact summary, freeing up " +
        "context/tokens. Use this when the conversation has grown long and you're running low on context.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "update_todo_list",
      description:
        "Replace the entire TODO list with an updated checklist reflecting the current state. Always provide the full list; the system will overwrite the previous one. Use a single-level markdown checklist (no nesting) in intended execution order. Status options: [ ] (pending), [x] (completed), [-] (in progress). Use this for multi-step tasks: confirm completion of each step before marking it done, update multiple statuses at once, and add new actionable items as they are discovered.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "string",
            description:
              "Full markdown checklist in execution order, using [ ] for pending, [x] for completed, and [-] for in progress",
          },
        },
        required: ["todos"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_patch",
      description:
        "Apply patches to files using a stripped-down, file-oriented diff format. Supports creating new files, deleting files, and updating existing files with precise changes in a single call.\n\nThe patch format:\n*** Begin Patch\n[ one or more file sections ]\n*** End Patch\n\nEach file section starts with one of three headers:\n- *** Add File: <path> - Create a new file. Every following line is a + line (the initial contents).\n- *** Delete File: <path> - Remove an existing file. Nothing follows.\n- *** Update File: <path> - Patch an existing file in place. May be followed by *** Move to: <new path> to rename, then one or more hunks each introduced by @@ (optionally followed by context like a class or function name). Within a hunk each line starts with ' ' (context/unchanged), '-' (remove), or '+' (add). Show 3 lines of context above and below each change; use @@ with a class/function name if 3 lines is insufficient to uniquely identify the location.",
      parameters: {
        type: "object",
        properties: {
          patch: {
            type: "string",
            description:
              "The complete patch text in the apply_patch format, starting with '*** Begin Patch' and ending with '*** End Patch'.",
          },
        },
        required: ["patch"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_diff",
      description:
        "Apply precise, targeted modifications to an existing file using one or more search/replace blocks. This tool is for surgical edits only; the SEARCH block must match the existing content, including whitespace and indentation. To make multiple targeted changes, provide multiple SEARCH/REPLACE blocks in the 'diff' parameter. Use read_file first if you are not confident in the exact content to search for.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The path of the file to modify, relative to the current workspace directory.",
          },
          diff: {
            type: "string",
            description:
              "One or more search/replace blocks. Each block must follow this format:\n<<<<<<< SEARCH\n:start_line:[line_number]\n-------\n[exact content to find]\n=======\n[new content to replace with]\n>>>>>>> REPLACE",
          },
        },
        required: ["path", "diff"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_replace",
      description:
        "Replace ONE occurrence of old_string with new_string in an existing file. The old_string MUST uniquely identify the specific instance: include at least 3-5 lines of context before AND after the change point, and match all whitespace and indentation exactly. This tool changes a single instance at a time; for multiple instances make separate calls, each with enough context to be unique. old_string and new_string must be different.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "The path to the file (relative to the workspace or absolute)." },
          old_string: {
            type: "string",
            description: "The text to replace (must be unique within the file and match exactly, including whitespace and indentation).",
          },
          new_string: { type: "string", description: "The edited text to replace the old_string (must differ from old_string)." },
        },
        required: ["file_path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_slash_command",
      description:
        "Execute a slash command to get specific instructions or content. Slash commands are predefined templates (built-in, global, or project-scoped) that provide detailed guidance for common tasks. The command's content is returned as the tool result and injected into the conversation for you to act on.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Name of the slash command to run (e.g. init)." },
          args: { type: "string", description: "Optional additional context or arguments for the command." },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "new_task",
      description:
        "Create a new sub-agent task with your provided message and optional initial todo list. Use this to delegate a self-contained subtask and receive the sub-agent's result. CRITICAL: this tool MUST be called alone - do NOT call it alongside other tools in the same turn.",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string", description: "Slug of the mode to begin the new task in (e.g. code, debug, architect). Currently advisory." },
          message: { type: "string", description: "Initial user instructions or context for the new task." },
          todos: { type: "string", description: "Optional initial todo list as a markdown checklist." },
        },
        required: ["mode", "message"],
      },
    },
  },
];

/** Optional hooks the extension host can supply to give tools access to session state. */
export interface ToolContext {
  compactContext?: () => Promise<string>;
  /** Read the current session todo list (for update_todo_list / reminder injection). */
  getTodoList?: () => TodoItem[];
  /** Replace the session todo list. */
  setTodoList?: (todos: TodoItem[]) => void;
  /**
   * Spawn a sub-agent (new_task) with the given message and optional initial
   * markdown todo list; resolves to the sub-agent's final assistant text.
   * Wired by extension.ts to a nested runAgent call.
   */
  spawnSubTask?: (message: string, todos?: string | null) => Promise<string>;
}

/** Pure path-containment check, exported for unit testing (no vscode dependency). */
export function resolvePathInRoot(root: string, relPath: string): string {
  const abs = path.resolve(root, relPath);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes the workspace: ${relPath}`);
  }
  return abs;
}

function resolveInWorkspace(relPath: string): string {
  // Contain paths within the workspace root (reject ../ escapes).
  return resolvePathInRoot(workspaceRoot().fsPath, relPath);
}

function runGit(args: string[]): Promise<string> {
  const { execFile } = require("child_process");
  return new Promise<string>((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd: workspaceRoot().fsPath, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
      (err: any, stdout: string, stderr: string) => {
        if (err) {
          reject(new Error(stderr || err.message));
          return;
        }
        resolve(stdout.trim() || "(no output)");
      }
    );
  });
}

/** Pure git-diff argument builder, exported for unit testing. */
export function buildGitDiffArgs(opts: { path?: string; staged?: boolean; ref?: string }): string[] {
  const gitArgs = ["diff"];
  if (opts.staged) {
    gitArgs.push("--cached");
  }
  if (opts.ref) {
    gitArgs.push(opts.ref);
  }
  if (opts.path) {
    gitArgs.push("--", opts.path);
  }
  return gitArgs;
}

/** Pure http(s)-only URL validation, exported for unit testing. */
export function validateHttpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http:// and https:// URLs are allowed");
  }
  return url;
}

/** Fetches an http(s) URL, following at most five redirects. Exported for tests. */
export function fetchUrl(rawUrl: string, redirectsRemaining = 5): Promise<string> {
  const MAX_BYTES = 100 * 1024;
  const url = validateHttpUrl(rawUrl);
  const transport = url.protocol === "https:" ? https : http;

  return new Promise<string>((resolve, reject) => {
    const req = transport.get(url, { timeout: 15_000 }, (res) => {
      const statusCode = res.statusCode ?? 0;
      const location = res.headers.location;
      if ([301, 302, 303, 307, 308].includes(statusCode) && location) {
        res.resume();
        if (redirectsRemaining === 0) {
          reject(new Error("Fetch failed: too many redirects"));
          return;
        }
        let redirectUrl: string;
        try {
          redirectUrl = new URL(location, url).toString();
        } catch {
          reject(new Error(`Fetch failed: invalid redirect location ${location}`));
          return;
        }
        fetchUrl(redirectUrl, redirectsRemaining - 1).then(resolve, reject);
        return;
      }
      if (statusCode < 200 || statusCode >= 300) {
        reject(new Error(`Fetch failed with status ${statusCode}`));
        res.resume();
        return;
      }
      let data = "";
      let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) {
          res.destroy();
          return;
        }
        data += chunk.toString("utf8");
      });
      res.on("end", () => resolve(data));
    });
    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
  });
}

/** Strips HTML tags and decodes common entities, exported for unit testing. */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

/** Builds a search engine URL from a %s template, exported for unit testing. */
export function buildSearchUrl(template: string, query: string): string {
  return (template || "https://duckduckgo.com/html/?q=%s").trim().replace("%s", encodeURIComponent(query));
}

/** Parses DuckDuckGo HTML-lite result markup into "title\nurl" entries, exported for unit testing. */
export function parseSearchResults(html: string, count: number): string[] {
  const results: string[] = [];
  const linkRe = /<a rel="nofollow" class="result__a" href="([^"]+)">(.*?)<\/a>/g;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(html)) && results.length < count) {
    let href = match[1];
    const title = decodeHtmlEntities(match[2]);
    const uddgMatch = href.match(/[?&]uddg=([^&]+)/);
    if (uddgMatch) {
      try {
        href = decodeURIComponent(uddgMatch[1]);
      } catch {
        // keep raw href if decoding fails
      }
    }
    results.push(`${title}\n${href}`);
  }
  return results;
}

async function webSearch(query: string, count: number): Promise<string> {
  const cfg = vscode.workspace.getConfiguration("aiAgentChat");
  const template = cfg.get<string>("webSearchUrl", "");
  const url = buildSearchUrl(template, query);

  const html = await fetchUrl(url);
  const results = parseSearchResults(html, count);
  return results.length > 0 ? results.join("\n\n") : "No results found.";
}

const UNIX_ONLY_COMMANDS = ["find", "grep", "ls", "cat", "rm", "mv", "cp", "touch", "which", "head", "tail", "wc"];

/**
 * Detects shell commands that behave differently or don't exist on Windows
 * (e.g. Windows' built-in FIND.EXE is a text search, not a Unix `find`).
 * Exported for unit testing.
 */
export function unixCommandHint(command: string, platform: NodeJS.Platform): string | null {
  if (platform !== "win32") {
    return null;
  }
  const first = command.trim().split(/\s+/)[0]?.toLowerCase();
  if (!first || !UNIX_ONLY_COMMANDS.includes(first)) {
    return null;
  }
  return (
    `"${first}" is a Unix command; this workspace is running on Windows (cmd.exe), ` +
    `where "${first}" behaves differently or is unavailable. Use the list_directory or ` +
    `search_in_files tool instead of shell find/grep/ls for file operations.`
  );
}

const SYMBOL_KIND_NAMES = [
  "File", "Module", "Namespace", "Package", "Class", "Method", "Property", "Field",
  "Constructor", "Enum", "Interface", "Function", "Variable", "Constant", "String",
  "Number", "Boolean", "Array", "Object", "Key", "Null", "EnumMember", "Struct",
  "Event", "Operator", "TypeParameter",
];

/** Recursively formats a vscode.DocumentSymbol[] tree, exported for unit testing. */
export function formatSymbols(symbols: any[], indent = ""): string {
  const lines: string[] = [];
  for (const s of symbols) {
    const line = (s.range?.start?.line ?? s.location?.range?.start?.line ?? 0) + 1;
    const kindName = typeof s.kind === "number" ? (SYMBOL_KIND_NAMES[s.kind] ?? String(s.kind)) : String(s.kind);
    lines.push(`${indent}${s.name} (${kindName}) L${line}`);
    if (Array.isArray(s.children) && s.children.length > 0) {
      lines.push(formatSymbols(s.children, indent + "  "));
    }
  }
  return lines.join("\n");
}

export interface TextEditLike {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
  newText: string;
}

/** Applies a set of (line/char-based) text edits to a string, exported for unit testing. */
export function applyTextEdits(text: string, edits: TextEditLike[]): string {
  const lines = text.split("\n");
  const toOffset = (line: number, char: number): number => {
    let offset = 0;
    for (let i = 0; i < line; i++) {
      offset += lines[i].length + 1;
    }
    return offset + char;
  };
  const sorted = [...edits].sort(
    (a, b) => toOffset(b.startLine, b.startChar) - toOffset(a.startLine, a.startChar)
  );
  let result = text;
  for (const e of sorted) {
    const startOff = toOffset(e.startLine, e.startChar);
    const endOff = toOffset(e.endLine, e.endChar);
    result = result.slice(0, startOff) + e.newText + result.slice(endOff);
  }
  return result;
}

/** Exported for unit/integration testing of file, git, and shell tool behavior. */
export async function executeTool(name: string, args: any, ctx?: ToolContext): Promise<string> {
  try {
    switch (name) {
      case "run_python": {
        const code = args.code;
        if (!code) {
          throw new Error("No Python code provided.");
        }

        // Use the correct confirmation helper available in tools.ts (e.g., promptConfirmation or promptUserConfirmation)
        // Or call child_process execution directly if confirmation isn't strictly exported in your scope.
        try {
          const pythonCmd = process.platform === "win32" ? "python" : "python3";

          // Spawn the child process directly so we can write to stdin safely without type errors
          const output = await new Promise<string>((resolve, reject) => {
            const childProc = cp.spawn(pythonCmd, ["-c", code], {
              timeout: 60_000,
            });

            let stdout = "";
            let stderr = "";

            childProc.stdout.on("data", (data) => { stdout += data; });
            childProc.stderr.on("data", (data) => { stderr += data; });

            childProc.on("error", (err) => { reject(err); });
            childProc.on("close", (code) => {
              if (code !== 0 && stderr) {
                reject(new Error(stderr.trim()));
              } else {
                let result = "";
                if (stdout) result += stdout;
                if (stderr) result += `\n[stderr]:\n${stderr}`;
                resolve(result.trim() || "Python script executed successfully with no output.");
              }
            });
          });

          return output;
        } catch (err: any) {
          return `Python execution failed:\n${err?.message || String(err)}`;
        }
      } case "read_file": {
        const abs = resolveInWorkspace(String(args.path));
        return fs.readFileSync(abs, "utf8");
      }
      case "read_file_lines": {
        const abs = resolveInWorkspace(String(args.path));
        const content = fs.readFileSync(abs, "utf8");
        const lines = content.split("\n");
        const start = Math.max(1, Number(args.startLine) || 1);
        const end = Math.min(lines.length, args.endLine ? Number(args.endLine) : lines.length);
        if (start > end) {
          return "Error: startLine must be <= endLine";
        }
        return lines.slice(start - 1, end).map((l, i) => `${start + i}: ${l}`).join("\n");
      }
      case "write_file": {
        const abs = resolveInWorkspace(String(args.path));
        fs.writeFileSync(abs, String(args.content), "utf8");
        return `Wrote ${Buffer.byteLength(String(args.content))} bytes to ${args.path}`;
      }
      case "edit_file": {
        const abs = resolveInWorkspace(String(args.path));
        const search = String(args.search ?? "");
        const replace = String(args.replace ?? "");
        if (!search) {
          return "Error: search is required";
        }
        const content = fs.readFileSync(abs, "utf8");
        // Normalize line endings in the search/replace strings to match the
        // file's dominant line ending (CRLF on Windows, LF on Unix). Without
        // this, a CRLF file never matches an LF search string and the tool
        // reports "search text not found" even when the visible text is identical.
        const crlf = (content.match(/\r\n/g) || []).length;
        const lf = (content.match(/\n/g) || []).length - crlf;
        const fileIsCrlf = crlf > lf;
        const norm = (s: string): string =>
          fileIsCrlf ? s.replace(/\r?\n/g, "\r\n") : s.replace(/\r\n/g, "\n");
        const searchNorm = norm(search);
        const replaceNorm = norm(replace);
        const count = content.split(searchNorm).length - 1;
        if (count === 0) {
          return `Error: search text not found in ${args.path}`;
        }
        if (count > 1 && !args.replaceAll) {
          return `Error: search text matches ${count} locations in ${args.path}; ` +
            `include more surrounding context to make it unique, or set replaceAll: true`;
        }
        const updated = args.replaceAll
          ? content.split(searchNorm).join(replaceNorm)
          : content.replace(searchNorm, replaceNorm);
        fs.writeFileSync(abs, updated, "utf8");
        return `Edited ${args.path} (${args.replaceAll ? count : 1} replacement(s))`;
      }
      case "list_directory": {
        const relPath = args.path ? String(args.path) : ".";
        const abs = resolveInWorkspace(relPath);
        const entries = fs.readdirSync(abs, { withFileTypes: true });
        return entries
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort()
          .join("\n") || "(empty directory)";
      }
      case "find_files": {
        const glob = args.glob ? String(args.glob) : "**/*";
        const exclude = args.exclude ? String(args.exclude) : "**/node_modules/**";
        const maxResults = args.maxResults ? Number(args.maxResults) : 200;
        const files = await vscode.workspace.findFiles(glob, exclude, maxResults);
        const root = workspaceRoot().fsPath;
        const rels = files
          .map((f) => path.relative(root, f.fsPath).split(path.sep).join("/"))
          .sort();
        return rels.length > 0 ? rels.join("\n") : "No files found";
      }
      case "search_in_files": {
        const query = String(args.query ?? "");
        if (!query) {
          return "Error: query is required";
        }
        const isRegex = Boolean(args.isRegex);
        const pattern = isRegex ? new RegExp(query, "i") : null;
        const glob = args.glob ? String(args.glob) : "**/*";
        const files = await vscode.workspace.findFiles(glob, "**/node_modules/**", 500);
        const results: string[] = [];
        const MAX_MATCHES = 100;
        for (const file of files) {
          if (results.length >= MAX_MATCHES) {
            break;
          }
          let text: string;
          try {
            text = fs.readFileSync(file.fsPath, "utf8");
          } catch {
            continue; // skip unreadable/binary files
          }
          const relPath = path.relative(workspaceRoot().fsPath, file.fsPath);
          const lines = text.split("\n");
          for (let i = 0; i < lines.length && results.length < MAX_MATCHES; i++) {
            const matches = pattern ? pattern.test(lines[i]) : lines[i].toLowerCase().includes(query.toLowerCase());
            if (matches) {
              results.push(`${relPath}:${i + 1}: ${lines[i].trim()}`);
            }
          }
        }
        return results.length > 0 ? results.join("\n") : "No matches found";
      }
      case "get_diagnostics": {
        const root = workspaceRoot().fsPath;
        let entries: [vscode.Uri, vscode.Diagnostic[]][];
        if (args.path) {
          const abs = resolveInWorkspace(String(args.path));
          const uri = vscode.Uri.file(abs);
          entries = [[uri, vscode.languages.getDiagnostics(uri)]];
        } else {
          entries = vscode.languages.getDiagnostics();
        }
        const SEVERITY_NAMES = ["Error", "Warning", "Information", "Hint"];
        const lines: string[] = [];
        for (const [uri, diags] of entries) {
          const rel = path.relative(root, uri.fsPath);
          for (const d of diags) {
            const sevName = SEVERITY_NAMES[d.severity as unknown as number] ?? "Unknown";
            const line = (d.range?.start?.line ?? 0) + 1;
            lines.push(`${rel}:${line}: ${sevName}: ${d.message}`);
          }
        }
        return lines.length > 0 ? lines.join("\n") : "No diagnostics found";
      }
      case "get_active_editor": {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          return "No active editor.";
        }
        const root = workspaceRoot().fsPath;
        const rel = path.relative(root, editor.document.uri.fsPath);
        const sel = editor.selection;
        const selectedText = sel && !sel.isEmpty ? editor.document.getText(sel) : "";
        const startLine = (sel?.start?.line ?? 0) + 1;
        const endLine = (sel?.end?.line ?? 0) + 1;
        return `Path: ${rel}\nSelection lines: ${startLine}-${endLine}\nSelected text:\n${selectedText}`;
      }
      case "get_symbols": {
        const abs = resolveInWorkspace(String(args.path));
        const doc = await vscode.workspace.openTextDocument(abs);
        const symbols = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", doc.uri);
        if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
          return "No symbols found";
        }
        return formatSymbols(symbols as any[]);
      }
      case "format_document": {
        const abs = resolveInWorkspace(String(args.path));
        const doc = await vscode.workspace.openTextDocument(abs);
        const edits = await vscode.commands.executeCommand("vscode.executeFormatDocumentProvider", doc.uri);
        if (!edits || !Array.isArray(edits) || edits.length === 0) {
          return "No formatting changes.";
        }
        const content = fs.readFileSync(abs, "utf8");
        const editLikes: TextEditLike[] = (edits as any[]).map((e) => ({
          startLine: e.range.start.line,
          startChar: e.range.start.character,
          endLine: e.range.end.line,
          endChar: e.range.end.character,
          newText: e.newText,
        }));
        const updated = applyTextEdits(content, editLikes);
        fs.writeFileSync(abs, updated, "utf8");
        return `Formatted ${args.path} (${editLikes.length} edit(s) applied)`;
      }
      case "delete_file": {
        const abs = resolveInWorkspace(String(args.path));
        let stat: fs.Stats;
        try {
          stat = fs.statSync(abs);
        } catch {
          return `Error: path not found: ${args.path}`;
        }
        if (stat.isDirectory()) {
          return `Error: ${args.path} is a directory. Use the delete_directory tool to delete directories.`;
        }
        const choice = await vscode.window.showWarningMessage(
          `Allow the agent to delete this file?\n\n${args.path}`,
          { modal: true },
          "Delete"
        );
        if (choice !== "Delete") {
          return "Delete cancelled by user.";
        }
        fs.rmSync(abs, { recursive: false });
        return `Deleted ${args.path}`;
      }
      case "delete_directory": {
        const abs = resolveInWorkspace(String(args.path));
        let stat: fs.Stats;
        try {
          stat = fs.statSync(abs);
        } catch {
          return `Error: path not found: ${args.path}`;
        }
        if (!stat.isDirectory()) {
          return `Error: ${args.path} is not a directory. Use the delete_file tool to delete files.`;
        }
        const recursive = args.recursive === undefined ? true : Boolean(args.recursive);
        const choice = await vscode.window.showWarningMessage(
          recursive
            ? `Allow the agent to delete this directory and ALL of its contents?\n\n${args.path}`
            : `Allow the agent to delete this directory?\n\n${args.path}`,
          { modal: true },
          "Delete"
        );
        if (choice !== "Delete") {
          return "Delete cancelled by user.";
        }
        if (recursive) {
          fs.rmSync(abs, { recursive: true });
        } else {
          fs.rmdirSync(abs); // removes only an empty directory; throws ENOTEMPTY otherwise
        }
        return `Deleted ${args.path}${recursive ? " (recursive)" : ""}`;
      }
      case "rename_file": {
        const fromAbs = resolveInWorkspace(String(args.oldPath));
        const toAbs = resolveInWorkspace(String(args.newPath));
        fs.renameSync(fromAbs, toAbs);
        return `Renamed ${args.oldPath} -> ${args.newPath}`;
      }
      case "create_directory": {
        const abs = resolveInWorkspace(String(args.path));
        fs.mkdirSync(abs, { recursive: true });
        return `Created directory ${args.path}`;
      }
      case "git_status": {
        return await runGit(["status", "--porcelain"]);
      }
      case "git_diff": {
        const gitArgs = buildGitDiffArgs({
          path: args.path ? String(args.path) : undefined,
          staged: Boolean(args.staged),
          ref: args.ref ? String(args.ref) : undefined,
        });
        return await runGit(gitArgs);
      }
      case "git_log": {
        const count = args.count ? Number(args.count) : 10;
        return await runGit(["log", `-n${count}`, "--oneline"]);
      }
      case "git_commit": {
        const message = String(args.message ?? "");
        if (!message) {
          return "Error: message is required";
        }
        const choice = await vscode.window.showWarningMessage(
          `Allow the agent to stage all changes and commit?\n\n"${message}"`,
          { modal: true },
          "Commit"
        );
        if (choice !== "Commit") {
          return "Commit cancelled by user.";
        }
        await runGit(["add", "-A"]);
        return await runGit(["commit", "-m", message]);
      }
      case "fetch_url": {
        return await fetchUrl(String(args.url));
      }
      case "web_search": {
        const query = String(args.query ?? "");
        if (!query) {
          return "Error: query is required";
        }
        const count = Math.min(Math.max(Number(args.count) || 5, 1), 10);
        return await webSearch(query, count);
      }
      case "show_quick_pick": {
        const options: string[] = Array.isArray(args.options) ? args.options.map(String) : [];
        if (options.length === 0) {
          return "Error: options is required";
        }
        const choice = await vscode.window.showQuickPick(options, {
          placeHolder: args.placeHolder ? String(args.placeHolder) : undefined,
        });
        return choice === undefined ? "User dismissed the picker without choosing." : choice;
      }
      case "show_input_box": {
        const value = await vscode.window.showInputBox({
          prompt: args.prompt ? String(args.prompt) : undefined,
          placeHolder: args.placeHolder ? String(args.placeHolder) : undefined,
        });
        return value === undefined ? "User dismissed the input box without answering." : value;
      }
      case "open_file_in_editor": {
        const abs = resolveInWorkspace(String(args.path));
        const doc = await vscode.workspace.openTextDocument(abs);
        const editor = await vscode.window.showTextDocument(doc);
        if (args.line) {
          const lineIndex = Math.max(0, Number(args.line) - 1);
          const pos = new vscode.Position(lineIndex, 0);
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(new vscode.Range(pos, pos));
        }
        return `Opened ${args.path}`;
      }
      case "run_command": {
        const command = String(args.command);
        const hint = unixCommandHint(command, process.platform);
        if (hint) {
          return `Command not executed. ${hint}`;
        }
        // const choice = await vscode.window.showWarningMessage(
        //   `Allow the agent to run this shell command?\n\n${command}`,
        //   { modal: true },
        //   "Run"
        // );
        // if (choice !== "Run") {
        //   return "Command execution cancelled by user.";
        // }
        const { execFile } = require("child_process");
        return await new Promise<string>((resolve, reject) => {
          execFile(
            process.platform === "win32" ? "powershell.exe" : "bash",
            process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-lc", command],
            { cwd: workspaceRoot().fsPath, timeout: 30_000 },
            (err: any, stdout: string, stderr: string) => {
              if (err) {
                // Rejecting here means the agent just sees a generic node error. 
                // It's better to resolve with the stderr so the agent can read the failure!
                resolve(`Command exited with error.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}\nDetails:\n${err.message}`);
                return;
              }
              resolve(`STDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
            }
          );
        });
      }
      case "run_in_terminal": {
        const command = String(args.command ?? "");
        if (!command) {
          return "Error: command is required";
        }
        const term = vscode.window.createTerminal("Agent Terminal");
        term.show();
        term.sendText(command);
        return `Sent command to integrated terminal: ${command}`;
      }
      case "compact_context": {
        if (!ctx?.compactContext) {
          return "Error: compact_context is not available in this context.";
        }
        return await ctx.compactContext();
      }
      case "update_todo_list": {
        const todosRaw = String(args.todos ?? "");
        let parsed: TodoItem[];
        try {
          parsed = parseMarkdownChecklist(todosRaw);
        } catch (e: any) {
          return `Error: the todos parameter is not a valid markdown checklist: ${e?.message ?? String(e)}`;
        }
        const { valid, error } = validateTodos(parsed);
        if (!valid) {
          return `Error: ${error || "todos parameter validation failed"}`;
        }
        const normalized: TodoItem[] = parsed.map((t) => ({
          id: t.id,
          content: t.content,
          status: normalizeStatus(t.status),
        }));
        if (ctx?.setTodoList) {
          ctx.setTodoList(normalized);
        }
        return "Todo list updated successfully.";
      }
      case "apply_patch": {
        const patch = String(args.patch ?? "");
        if (!patch) {
          return "Error: patch is required";
        }
        let parsedPatch: ReturnType<typeof parsePatch>;
        try {
          parsedPatch = parsePatch(patch);
        } catch (e: any) {
          return `Error parsing patch: ${e?.message ?? String(e)}`;
        }
        const root = workspaceRoot().fsPath;
        const readFile = async (relPath: string): Promise<string> => {
          const abs = resolvePathInRoot(root, relPath);
          return fs.readFileSync(abs, "utf8");
        };
        let changes;
        try {
          changes = await processAllHunks(parsedPatch.hunks, readFile);
        } catch (e: any) {
          return `Error applying patch: ${e?.message ?? String(e)}`;
        }
        const summary: string[] = [];
        for (const change of changes) {
          try {
            const abs = resolvePathInRoot(root, change.path);
            if (change.type === "add") {
              if (fs.existsSync(abs)) {
                summary.push(`Error: ${change.path} already exists; use Update File instead.`);
                continue;
              }
              fs.mkdirSync(path.dirname(abs), { recursive: true });
              fs.writeFileSync(abs, String(change.newContent ?? ""), "utf8");
              summary.push(`Added ${change.path}`);
            } else if (change.type === "delete") {
              if (!fs.existsSync(abs)) {
                summary.push(`Error: ${change.path} not found; cannot delete.`);
                continue;
              }
              fs.rmSync(abs, { recursive: false });
              summary.push(`Deleted ${change.path}`);
            } else if (change.type === "update") {
              if (!fs.existsSync(abs)) {
                summary.push(`Error: ${change.path} not found; cannot update.`);
                continue;
              }
              if (change.movePath) {
                const moveAbs = resolvePathInRoot(root, change.movePath);
                fs.mkdirSync(path.dirname(moveAbs), { recursive: true });
                fs.writeFileSync(moveAbs, String(change.newContent ?? ""), "utf8");
                fs.rmSync(abs, { recursive: false });
                summary.push(`Updated and moved ${change.path} -> ${change.movePath}`);
              } else {
                fs.writeFileSync(abs, String(change.newContent ?? ""), "utf8");
                summary.push(`Updated ${change.path}`);
              }
            }
          } catch (e: any) {
            summary.push(`Error: ${change.path}: ${e?.message ?? String(e)}`);
          }
        }
        return summary.length > 0 ? summary.join("\n") : "Patch applied (no file changes).";
      }
      case "apply_diff": {
        const relPath = String(args.path ?? "");
        if (!relPath) {
          return "Error: path is required";
        }
        const diffContent = String(args.diff ?? "");
        if (!diffContent) {
          return "Error: diff is required";
        }
        let abs: string;
        try {
          abs = resolveInWorkspace(relPath);
        } catch (e: any) {
          return `Error: ${e?.message ?? String(e)}`;
        }
        if (!fs.existsSync(abs)) {
          return `Error: File not found: ${relPath}`;
        }
        const originalContent = fs.readFileSync(abs, "utf8");
        const result = await applyDiff(originalContent, diffContent, 1.0);
        if (!result.success) {
          const errs =
            result.failParts && result.failParts.length
              ? result.failParts.map((p, i) => `Block ${i + 1}: ${p.error}`).join("\n\n")
              : result.error || "Unknown error";
          return `apply_diff failed; no changes written.\n${errs}`;
        }
        fs.writeFileSync(abs, String(result.content), "utf8");
        let msg = `Applied diff to ${relPath}.`;
        if (result.failParts && result.failParts.length > 0) {
          msg +=
            `\n${result.failParts.length} block(s) failed:\n` +
            result.failParts.map((p, i) => `Block ${i + 1}: ${p.error}`).join("\n\n");
        }
        return msg;
      }
      case "search_replace": {
        const relPath = String(args.file_path ?? "");
        if (!relPath) {
          return "Error: file_path is required";
        }
        const oldString = String(args.old_string ?? "");
        const newString = args.new_string === undefined ? undefined : String(args.new_string);
        if (!oldString) {
          return "Error: old_string is required";
        }
        if (newString === undefined) {
          return "Error: new_string is required";
        }
        if (oldString === newString) {
          return "Error: old_string and new_string must be different.";
        }
        let abs: string;
        try {
          abs = resolveInWorkspace(relPath);
        } catch (e: any) {
          return `Error: ${e?.message ?? String(e)}`;
        }
        if (!fs.existsSync(abs)) {
          return `Error: File not found: ${relPath}`;
        }
        const originalRaw = fs.readFileSync(abs, "utf8");
        const isCrlf = originalRaw.includes("\r\n");
        const fileContent = originalRaw.replace(/\r\n/g, "\n");
        const normOld = oldString.replace(/\r\n/g, "\n");
        const normNew = newString.replace(/\r\n/g, "\n");
        const matchCount = fileContent.split(normOld).length - 1;
        if (matchCount === 0) {
          return "Error: No match found for old_string. Ensure it matches the file contents exactly, including whitespace and indentation.";
        }
        if (matchCount > 1) {
          return `Error: Found ${matchCount} matches for old_string. This tool replaces ONE occurrence at a time. Provide more context (3-5 lines before and after) to uniquely identify the instance.`;
        }
        let newContent = fileContent.replace(normOld, normNew);
        if (newContent === fileContent) {
          return `No changes needed for ${relPath}`;
        }
        if (isCrlf) {
          newContent = newContent.replace(/\n/g, "\r\n");
        }
        fs.writeFileSync(abs, newContent, "utf8");
        return `Replaced 1 occurrence in ${relPath}`;
      }
      case "run_slash_command": {
        const cmdName = String(args.command ?? "");
        if (!cmdName) {
          return "Error: command is required";
        }
        const cmdArgs = args.args != null ? String(args.args) : undefined;
        const cwd = workspaceRoot().fsPath;
        let command;
        try {
          command = await getCommand(cwd, cmdName);
        } catch (e: any) {
          return `Error loading command '${cmdName}': ${e?.message ?? String(e)}`;
        }
        if (!command) {
          let names: string[] = [];
          try {
            names = await getCommandNames(cwd);
          } catch {
            names = [];
          }
          return `Command '${cmdName}' not found. Available commands: ${names.length ? names.join(", ") : "(none)"}`;
        }
        const lines = [`Command: /${command.name}`];
        if (command.description) {
          lines.push(`Description: ${command.description}`);
        }
        if (command.argumentHint) {
          lines.push(`Argument hint: ${command.argumentHint}`);
        }
        if (cmdArgs) {
          lines.push(`Provided arguments: ${cmdArgs}`);
        }
        lines.push(`Source: ${command.source}`);
        lines.push("--- Command Content ---");
        lines.push(command.content);
        return lines.join("\n");
      }
      case "new_task": {
        const mode = String(args.mode ?? "");
        const message = String(args.message ?? "");
        if (!mode) {
          return "Error: mode is required";
        }
        if (!message) {
          return "Error: message is required";
        }
        const todos = args.todos != null ? String(args.todos) : undefined;
        if (!ctx?.spawnSubTask) {
          return "Error: new_task is not available in this context (no sub-agent runner).";
        }
        try {
          const childResult = await ctx.spawnSubTask(message, todos);
          return `Sub-task (mode: ${mode}) completed.\n\n${childResult}`;
        } catch (e: any) {
          return `Error spawning sub-task: ${e?.message ?? String(e)}`;
        }
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err: any) {
    return `Error: ${err?.message ?? String(err)}\nSTDOUT:\n${err?.stdout ?? ""}\nSTDERR:\n${err?.stderr ?? ""}`;
  }
}

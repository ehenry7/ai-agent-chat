# AI Agent Chat for VS Code

An agentic chat assistant for VS Code, backed by an OpenAI-compatible
chat-completions API[cite: 1]. The agent can read and write files in your workspace
and run shell commands to help you complete tasks[cite: 1].

![Version](https://img.shields.io/badge/version-0.32.0-blue)

---

## Features

- **Sidebar chat with bottom toolbar** — an **AI Agent** icon in the Activity Bar (left bar)
  opens the chat docked beside your editor[cite: 1]. Model selection and action controls
  sit neatly in a bottom toolbar below the prompt input, grouping secondary actions
  (Refresh Models, Benchmark Models, Compact Context, Clear Chat, Settings) under a
  consolidated `☰ Menu` dropdown. **Chat state is fully retained when the view is hidden**:
  the transcript, selected model, in-flight agent runs, scroll position, draft text,
  and prompt height are preserved across view switches[cite: 1].
- **Full-width prompt resize splitter** — an edge-to-edge horizontal divider line above
  the prompt area lets you click and drag upward to enlarge the input box (minimum 48px,
  capped at 70% of view height). The height is remembered across view switches and
  window reloads[cite: 1].
- **Inline status line** — a compact status and step progress indicator positioned
  directly above the prompt area, aligned to the prompt width.
- **Direct slash commands** — enter slash commands directly in the prompt for instant local
  execution or guided task injection without consuming unnecessary API turns:
  - `/config` — instantly prints the active base URL, model, step limit, memory file, and API key status.
  - `/init` — prompts the agent to analyze the codebase and create or optimize `AGENTS.md`[cite: 5].
  - `/<custom>` — runs any custom markdown command template defined in `.ai-agent-chat/commands/` (workspace) or `~/.ai-agent-chat/commands/` (global)[cite: 5].
- **Local model & XML tool compatibility** — automatically detects and extracts `<tool_call>`
  XML markup embedded within message content (common in the GLM family and local Ollama models),
  converting them to native tool calls so agent runs continue seamlessly[cite: 1].
- **Markdown rendering** — assistant messages render as Markdown: headings, **bold** / *italic*
  / ~~strikethrough~~, `inline code`, fenced code blocks with language headers, blockquotes,
  nested lists, GFM tables with alignment, links, and horizontal rules[cite: 1]. Hand-rolled and
  dependency-free with an escape-first security model[cite: 1].
- **Syntax highlighting in code blocks** — fenced code blocks are tokenized by a built-in
  highlighter (no runtime dependencies, works under strict CSP) for 18+ language families
  and aliases[cite: 1]. Colors adapt to light, dark, and high-contrast themes[cite: 1].
- **Collapsible tool output** — completed tool calls render as compact one-line cards
  (chevron, tool name, preview, ✓) that expand on click[cite: 1].
- **Prompt history with ↑/↓ navigation** — press ↑ on the first line to browse previous
  prompts, ↓ to navigate forward; unsent drafts are preserved while browsing[cite: 1]. The last
  500 prompts, the draft, and the input height persist in `workspaceState` across restarts[cite: 1, 2].
- **Automatic retries on timeouts** — chat completion requests that encounter timeouts
  (120 s) or transient network errors (408, 429, 502, 503, 504, connection resets) retry
  automatically (3 attempts total, linear backoff)[cite: 1]. Stop aborts interrupt immediately[cite: 1].
- **Agent tools** — a comprehensive tool set available to the model during execution:
  - *File & workspace*: `read_file`, `read_file_lines`, `write_file`, `edit_file` (targeted search/replace),
    `list_directory`, `find_files`, `search_in_files` (safe regex and literal matching),
    `get_diagnostics`, `get_active_editor`, `get_symbols`, `format_document`, `delete_file`,
    `delete_directory`, `rename_file`, `create_directory`[cite: 1, 3, 4]
  - *Diff & Patching*: `apply_patch`, `apply_diff`, `search_replace`[cite: 4]
  - *Task Management*: `update_todo_list`, `new_task` (supports configurable step limits)[cite: 4]
  - *Version control*: `git_status`, `git_diff`, `git_log`, `git_commit`[cite: 1, 4]
  - *Web*: `fetch_url` (GET only, 100KB cap), `web_search` (queries search engine)[cite: 1, 4]
  - *VS Code UI*: `show_quick_pick`, `show_input_box`, `open_file_in_editor`[cite: 1, 4]
  - *Shell & execution*: `run_command`, `run_python`, `run_in_terminal`[cite: 1, 4]
  - *Session*: `compact_context`[cite: 1, 4]
  - *Memory*: `update_memory` — rewrites persistent markdown memory, injected into the system prompt every turn. Maintains **two independent scopes**: a **folder-scoped** file (`AGENTS.md` in the workspace) for project-specific notes that stay isolated per project, and a **global-scoped** file (`GLOBAL_AGENTS.md` in the extension's global storage, outside any workspace) for cross-project conventions shared across every project on this machine. The `scope` parameter selects which store to update (`"folder"` default, `"global"` optional, case-insensitive). Global memory is injected first (general context), folder memory last (specific context)[cite: 1, 4]

  All file tools enforce workspace path containment[cite: 1, 4]. Destructive actions (`delete_file`,
  `delete_directory`, `git_commit`) require confirmation[cite: 4].
- **Parallel read-only tool calls** — read-only tools run concurrently via `Promise.all`;
  mutating calls run sequentially to prevent conflicts[cite: 1].
- **Session persistence & failure recovery** — conversation history, UI transcript, todo lists,
  and models are saved to `.ai-agent-chat/session.json`[cite: 2, 3]. If the session exceeds storage
  thresholds, automatic context compaction is triggered to prevent silent data loss.
- **Model timing/benchmark** — the `⏱ Benchmark Models` option in the `☰ Menu` probes
  response latency across all available models[cite: 1, 2].

---

## Requirements

- VS Code 1.85 or later[cite: 1]
- An OpenAI-compatible chat-completions endpoint[cite: 1]

Defaults (adjust via settings):

| Setting | Default |
|---|---|
| `aiAgentChat.baseUrl` | *(empty — falls back to `http://techdev.hicomputing.huawei.com:18000`)*[cite: 1] |
| `aiAgentChat.model` | `GLM-5.2-1` (initial default only)[cite: 1] |
| `aiAgentChat.maxSteps` | `25` (agent loop steps per chat turn, supports up to 500)[cite: 1] |
| `aiAgentChat.webSearchUrl` | `https://duckduckgo.com/html/?q=%s`[cite: 1] |
| `aiAgentChat.apiKeyEnvVar` | *(empty — API key read from SecretStorage)*[cite: 1] |
| `aiAgentChat.memoryFile` | `AGENTS.md` (per-workspace folder-scoped memory)[cite: 1] |
| `aiAgentChat.globalMemoryFile` | `GLOBAL_AGENTS.md` (cross-project global memory in extension storage)[cite: 1] |

---

## Slash Commands

Type slash commands directly into the prompt box for instant execution:

| Command | Description |
|---|---|
| `/config` | Instantly outputs the current base URL, model, max steps, memory file, and API key status without making an LLM API call. |
| `/init` | Prompts the agent to inspect project structure, configs, and commands to generate or update `AGENTS.md`[cite: 5]. |
| `/<name>` | Executes any custom command defined in `.ai-agent-chat/commands/<name>.md` (workspace) or `~/.ai-agent-chat/commands/<name>.md` (global)[cite: 5]. |

---

## Configuration

Set values in VS Code settings (workspace/user scope) or via the setup screen (`☰ Menu` → `⚙️ Settings`):

- **API key** — stored securely in VS Code **SecretStorage**[cite: 1]. Can be set via the setup screen,
  `AI Agent Chat: Set API Key`, or mapped to an environment variable via `aiAgentChat.apiKeyEnvVar`[cite: 1].
- **`aiAgentChat.baseUrl`** — base URL of the OpenAI-compatible endpoint[cite: 1].
- **`aiAgentChat.maxSteps`** — maximum agent loop steps per chat turn (clamped 1–500, default 25)[cite: 1].
- **`aiAgentChat.webSearchUrl`** — search engine URL template for `web_search` (`%s` is replaced with query)[cite: 1].
- **`aiAgentChat.memoryFile`** — workspace-relative name of the **folder-scoped** memory file (default `AGENTS.md`). This holds the agent's persistent, project-specific understanding for the *current workspace only*; the notes stay isolated per project. Loaded on startup, injected into the system prompt, and kept current during a run via `update_memory` with `scope "folder"`. Must stay inside the workspace.
- **`aiAgentChat.globalMemoryFile`** — name of the **global** (cross-project) memory file (default `GLOBAL_AGENTS.md`), stored in the extension's global storage *outside any workspace* and therefore shared across every project on this machine. Loaded on startup, injected into the system prompt (before folder memory), and kept current via `update_memory` with `scope "global"`. Use it only for things not specific to a single project — general conventions, tooling preferences, and recurring gotchas.

```json
{
  "aiAgentChat.baseUrl": "[http://techdev.hicomputing.huawei.com:18000](http://techdev.hicomputing.huawei.com:18000)",
  "aiAgentChat.model": "GLM-5.2-1",
  "aiAgentChat.maxSteps": 25
}
```

### Security notes

- **API keys are stored in SecretStorage** (migrated automatically from
  legacy plaintext settings). Prefer the environment-variable option on
  shared machines.
- **TLS verification is ENABLED.** HTTPS endpoints are verified against
  the system CA store. (`rejectUnauthorized: false` is deliberately
  commented out in `src/apiClient.ts`.) If your environment requires
  bypassing TLS verification, edit that flag consciously — not
  recommended.
- **`delete_file`, `delete_directory`, and `git_commit`** each show a
  modal confirmation dialog before running. **`run_command` currently
  runs without a confirmation prompt** (the check is disabled in
  `src/tools.ts`; re-enabling it is on the roadmap) — treat the agent's
  shell access accordingly.
- **`fetch_url` makes outbound network requests** to whatever URL the
  model chooses (http/https only, GET only, 100KB response cap, 15s
  timeout, and up to five HTTP redirects). There is no domain allowlist
  yet — treat this like giving the agent limited internet access.
- **`web_search` also makes outbound network requests**, by default to
  `https://duckduckgo.com/html/?q=%s` (HTML scraped with a regex — no
  official API, so result quality/availability isn't guaranteed).
  Override `aiAgentChat.webSearchUrl` to point at an internal search
  engine if public DuckDuckGo isn't reachable from your network.
- **Markdown/highlighting security:** all model output is HTML-escaped
  before rendering; only renderer-generated tags are ever emitted, and
  link hrefs are restricted to http/https, so model text cannot inject
  markup or `javascript:` URLs into the webview.

---

## Usage

1. Open the sidebar using the **AI Agent** icon in the Activity Bar or run `AI Agent Chat: Open`.


2. Choose a model from the dropdown in the bottom toolbar. Use the `☰ Menu` to refresh or benchmark models.


3. Type your prompt and press **Enter** (or click **➤**); **Shift+Enter** inserts a newline.
4. Drag the horizontal splitter line above the prompt area upward to resize the input box.
5. Use `/config` to check active configurations or `/init` to generate workspace agent instructions.
6. Click **■ Stop** at any time to abort an in-flight agent run.

---

## Building

Full toolchain (Node.js + npm required). All targets run a clean build:
preflight checks → clean `out/` + old `*.vsix` → `npm ci` → `tsc` →
`vsce package`. The build also **installs the produced `.vsix` into VS
Code** (`code --install-extension`) by default — use `--no-install` to
skip that, and `--skip-deps` to reuse `node_modules` for a fast rebuild.
The README version badge is synced from `package.json` during the build.

```bash
npm run compile                 # tsc only (fast, no package)
npm run build                   # clean build + package .vsix (installs it)
npm run build -- --no-install   # build + package, but skip installing
npm run build -- --skip-deps    # reuse node_modules (fast clean build)
npm run build:fast              # --no-install --skip-deps (fastest)
```

On Windows you can also run `.\build.ps1` (wraps `node build.js`).

Install the produced `.vsix` manually:

```
code --install-extension ai-agent-chat-<version>.vsix
```

> Packaging note: the build passes `--allow-missing-repository` for
> local packaging; set a real `repository` in `package.json` before
> publishing to the Marketplace.

---

## Project Layout

```
src/extension.ts     Activation, secret management, prompt/slash command interception,
                     session persistence, and sub-task coordination[cite: 1, 2]
src/chatPanel.ts     ChatViewProvider: webview lifecycle, CSP/nonce, message routing[cite: 1]
src/webview/         Pure string builders for the webview (zero vscode dependency)[cite: 1]:
  html.ts            Document assembly, bottom toolbar layout, and setup overlay[cite: 1]
  styles.ts          Theme stylesheets, edge-to-edge resize splitter, and responsive layout[cite: 1]
  script.ts          Webview shell logic: state persistence, splitter drag handling,
                     prompt history navigation, and menu dispatch[cite: 1]
  highlight.ts       Highlighter tokenization and theme-aware syntax engine[cite: 1]
  markdown.ts        Dependency-free Markdown-to-HTML renderer[cite: 1]
  messages.ts        Chat message rendering, collapsible tool cards, and protocol dispatch[cite: 1]
src/agent.ts         Agent loop with XML <tool_call> fallback extraction and system prompts[cite: 1]
src/tools.ts         Full tool suite (files, diffs, patches, terminal, search, python)[cite: 1, 4]
src/apiClient.ts     HTTP client with TLS verification, retry backoff, and abort safety[cite: 1]
src/persistence.ts   Durable session snapshots plus two-scope memory persistence:
                     folder memory (AGENTS.md, per-workspace) and global memory
                     (GLOBAL_AGENTS.md, cross-project in extension storage)[cite: 1, 3]
src/tools/commands/  Slash-command loaders (built-in, global, and project scopes)[cite: 5]

```

---

## Development Notes

- TypeScript compiles to `out/` with source maps (`sourceMap: true`).
- No runtime npm dependencies; devDependencies are `@types/node`,
  `@types/vscode`, `typescript`, and `@vscode/vsce`.
- npm registry points to the internal Huawei mirror (`.npmrc`) with
  `audit=false` and `fund=false` to avoid interactive prompts.
- Run `npm test` to compile and execute tests, using Node's built-in
  `node:test` runner (no test framework dependency). A minimal `vscode`
  module stub (`test/vscode-stub.js`, wired up via
  `test/register-vscode-stub.js`) lets these run outside the VS Code
  extension host — it includes a real (simplified) glob engine for
  `find_files`/`search_in_files`, and configurable hooks for diagnostics,
  the active editor, `commands.executeCommand` (used by `get_symbols`/
  `format_document`), and terminal `sendText` calls (`run_in_terminal`).
  Suites:
  - `src/test/agent.test.ts` — pure/exported helper functions (path
    containment, URL validation, search parsing, Unix-command detection,
    `buildSystemPrompt`'s tool-list generation and win32/bash shell hint).
  - `src/test/agent-tools.test.ts` — integration tests that call the
    exported `executeTool()` directly against a real temp directory on
    disk (created/removed per test), covering `write_file`, `read_file`,
    `create_directory`, `list_directory`, `rename_file`, and `delete_file`
    (including the confirm/cancel paths via the stub's `__confirm` flag).
  - `src/test/tools-extra.test.ts` — tests for `edit_file`, `find_files`,
    `get_diagnostics`, `get_active_editor`, `read_file_lines`,
    `get_symbols`/`formatSymbols`, `git_diff`'s `buildGitDiffArgs`,
    `format_document`/`applyTextEdits`, and `run_in_terminal`.
  - `src/test/agent-network.test.ts` — **live** network tests that call
    `fetch_url` (against `https://example.com/`) and `web_search`
    (against the real configured search engine) with no mocking. It also
    has deterministic local-server tests for HTTP 302 redirects and the
    five-hop redirect limit. The public-network tests self-skip on an
    `Error:`/no-results result, so a sandboxed or intranet-only
    environment (like this project's default Huawei endpoint) doesn't
    break the suite.
  - `src/test/api-retry.test.ts` — classification of retriable vs
    non-retriable failures (`isRetriableError`): timeouts, socket resets,
    429/5xx vs. aborts and 4xx client errors.
  - `src/test/context-window.test.ts` — the two context-preservation
    mechanisms: per-tool truncation budget (`truncateToolOutput` capping
    data-heavy tools at ~12k chars) and the semantic sliding window
    (`applySemanticSlidingWindow` compressing older large `tool` messages
    while keeping the system prompt and most recent 8 messages intact).
    Pure helpers are unit-tested directly; the truncation integration
    cases exercise the real `executeTool` via the vscode stub.
  - `src/test/persistence.test.ts` — the session-snapshot and two-scope
    memory layer in `src/persistence.ts`: session serialize/parse/load/
    save/clear, folder and global memory stores, path containment, and
    the memory-byte cap (`MAX_MEMORY_BYTES`).
  - `src/test/webview-html.test.ts` — webview HTML assembly: nonce wiring
    into CSP/style/script tags, required element ids present, and a
    corruption guard asserting the emitted scripts contain no `${`
    sequences (see the template-literal lessons learned).
  - `src/test/webview-highlight.test.ts` — the syntax highlighter, loaded
    via `new Function()`: keyword/string/comment classes, HTML escaping
    of code content, plain-text fallback for unknown languages, and
    alias normalization.
  Tool bodies that call other real `vscode` UI APIs (quick pick, input
  box) or git are still not covered by these tests.
- **Webview conventions:** all webview HTML/CSS/JS is generated by pure
  string-builder modules in `src/webview/` with **no template literals**
  (historical `${` corruption — see the lessons-learned note in
  `src/chatPanel.ts`). The builders have no `vscode` dependency, which is
  what makes them testable outside the extension host. Keep new webview
  code following the same pattern.

---

## Known Limitations / Roadmap

* [ ] `run_command` approval prompt before executing (currently runs without prompt)


* [ ] User-configurable retry backoff and attempt count


* [ ] Configurable HTTP request timeout (currently 120 s per attempt)


* [ ] Syntax highlighting for tool output results based on file extensions


* [ ] Optional editor-tab chat mode alongside the sidebar view



Recently completed:

* [x] Markdown rendering in chat messages (dependency-free, escape-first)


* [x] Syntax highlighting for fenced code blocks (theme-aware)


* [x] Chat history re-render and session persistence across window reloads


* [x] Bottom toolbar layout with consolidated `☰ Menu` dropdown
* [x] Full-width edge-to-edge prompt resize splitter bar
* [x] Direct prompt slash commands (`/config`, `/init`, and custom commands)


* [x] Local model & XML tool-call parsing compatibility (`<tool_call>`)
* [x] Safe regular expression handling in `search_in_files`

* [x] Support for up to 500 Max Steps in primary runs and delegated sub-tasks

---

## Versioning

Every change to this extension bumps the **minor** version in
`package.json` (e.g. `0.30.4` → `0.31.0`), then rebuilds/repackages/
reinstalls the `.vsix`. The build syncs this README's version badge from
`package.json`, so the two stay in sync automatically.

---

## License

MIT — see the LICENSE file in the repository root.


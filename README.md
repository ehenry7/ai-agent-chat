# AI Agent Chat for VS Code

An agentic chat assistant for VS Code, backed by an OpenAI-compatible
chat-completions API. The agent can read and write files in your workspace
and run shell commands to help you complete tasks.

![Version](https://img.shields.io/badge/version-0.19.7-blue)

---

## Features

- **Sidebar chat** — an **AI Agent** icon in the Activity Bar (left bar);
  clicking it opens the chat docked beside your editor. Chat state is
  retained when the view is hidden.
- **Agent tools** — a broad tool set the model can call during a run:
  - *File & workspace*: `read_file`, `read_file_lines`, `write_file`,
    `edit_file` (targeted search/replace without rewriting the whole
    file), `list_directory`, `find_files` (glob-based discovery),
    `search_in_files`, `get_diagnostics`, `get_active_editor`,
    `get_symbols` (document outline), `format_document`, `delete_file`,
    `rename_file`, `create_directory`
  - *Version control*: `git_status`, `git_diff` (supports `staged` and
    `ref` options), `git_log`, `git_commit`
  - *Web*: `fetch_url` (GET only, http/https, response capped at 100KB),
    `web_search` (queries a configurable search engine and returns
    matching page titles/URLs)
  - *VS Code UI*: `show_quick_pick`, `show_input_box`, `open_file_in_editor`
  - *Shell*: `run_command`, `run_in_terminal` (visible integrated terminal,
    for long-running/interactive commands)
  - *Session*: `compact_context` — lets the model summarize and
    compact the conversation itself (mid-run) when it senses the
    context is getting long, in addition to the 🗄️ button below

  All file-path tools enforce path containment (they reject paths that
  escape the workspace). `run_command`, `delete_file`, and `git_commit`
  show a modal confirmation dialog before executing anything
  destructive or irreversible. `run_command` also detects Unix-only
  utilities (`find`, `grep`, `ls`, etc.) on Windows and returns guidance
  to use `list_directory`/`search_in_files` instead of executing a
  command that would just fail.
- **Incremental responses** — assistant text and tool output render as
  each agent step completes.
- **Parallel read-only tool calls** — when the model requests several
  tool calls in one turn, read-only ones (`read_file`, `list_directory`,
  `search_in_files`, `find_files`, `git_status`, `git_log`, `fetch_url`,
  `web_search`, `get_diagnostics`, `get_active_editor`, etc.) run
  concurrently via `Promise.all`; mutating calls (`write_file`,
  `run_command`, `git_commit`, ...) still run one at a time. Tool
  response messages are always reassembled in the original call order.
- **Oversized tool results are truncated** before being sent back to the
  model (default cap 8KB, cut at a valid UTF-8 boundary with a
  `…[truncated: N bytes, M lines → kept K bytes]` marker) to avoid
  blowing the context window; the chat view still shows the full,
  untruncated output.
- **Conversation history** — the last 20 prior messages are sent per
  turn; history is committed after a completed run.
- **Model selection** — a dropdown at the top of the chat view queries
  the configured server's `/models` endpoint and lets you switch models
  per-message. `aiAgentChat.model` is only the initial default (see
  Configuration). A 🔄 button re-queries the model list on demand.
- **Model timing/benchmark** — a ⏱ button sends a lightweight probe
  request to every available model, measures round-trip latency, and
  displays the result (or `(failed)`) next to each model name in the
  dropdown so you can pick the fastest one.
- **Stop button** — cancels the in-flight request and agent loop after
  Send but before the answer is fully received; aborts the underlying
  HTTP request and reports "Stopped by user." in the chat.
- **Compact context button** — a 🗄️ button asks the current model to
  summarize the whole conversation history, then replaces it with a
  single summary message, freeing up context/tokens for a long-running
  session. The summary is shown inline as a tool message; if history is
  already empty it's a no-op. The model can also trigger the same
  compaction itself via the `compact_context` tool.
- **Remote-friendly** — `extensionKind: ["workspace"]` so the extension
  runs in the remote host when using Remote-SSH.
- **Diagnostics logging** — the "AI Agent Chat" Output channel logs
  activation, webview lifecycle, model queries/timings, and chat/agent
  errors. Run `AI Agent Chat: Show Diagnostics` to open it quickly.

---

## Requirements

- VS Code 1.85 or later
- An OpenAI-compatible chat-completions endpoint

Defaults (adjust via settings):

| Setting | Default |
|---|---|
| `aiAgentChat.baseUrl` | *(empty — falls back to `http://techdev.hicomputing.huawei.com:18000`)* |
| `aiAgentChat.model` | `GLM-5.2-1` (initial default only — see below) |
| `aiAgentChat.apiKey` | *(empty — see Configuration)* |
| `aiAgentChat.maxSteps` | `15` (min 1, max 50 — agent loop steps per chat turn) |

> `aiAgentChat.model` is just the starting default model. Once the chat
> view is open, use the model dropdown to query the server for the
> actual list of available models and switch between them; your
> in-view selection takes priority over the setting for the current
> session.

---

## Configuration

There is no onboarding prompt — set the values in VS Code settings
(workspace or user scope) before chatting:

- **`aiAgentChat.apiKey`** — your API key (required).
- **`aiAgentChat.baseUrl`** — base URL of the OpenAI-compatible
  endpoint. If left empty, a built-in endpoint is used (see Defaults
  above).
- **`aiAgentChat.model`** — initial default model. Once the chat view
  is open, the model dropdown (queried from the server) takes priority
  for the current session.
- **`aiAgentChat.maxSteps`** — maximum number of agent loop steps
  (model calls) per chat turn before the agent stops itself, clamped to
  1–50 (default 15). The chat's `[step N/M]` status reflects this value.

Values are stored in workspace settings (`.vscode/settings.json` —
gitignored by default). You can edit them via the Settings UI, or open
`.vscode/settings.json` directly:

```json
{
  "aiAgentChat.apiKey": "sk-...",
  "aiAgentChat.baseUrl": "http://techdev.hicomputing.huawei.com:18000",
  "aiAgentChat.model": "GLM-5.2-1"
}
```

Open the chat with the **AI Agent** icon in the Activity Bar, or run
**`AI Agent Chat: Open`** from the Command Palette (`Ctrl+Shift+P`).
If the API key is missing when you send a message, the chat shows an
error reminding you to set it in settings.

**Note:** API keys entered with prefixes (`key: sk-…`, `bearer sk-…`) or
surrounding whitespace are automatically normalized and repaired in
stored settings at startup.

### Security notes

- **API keys are stored in plaintext** in workspace settings. For shared
  machines, prefer moving to `SecretStorage` (planned).
- **TLS verification is ENABLED.** HTTPS endpoints are verified against
  the system CA store. (`rejectUnauthorized: false` is deliberately
  commented out in `src/apiClient.ts`.) If your environment requires
  bypassing TLS verification, edit that flag consciously — not
  recommended.
- **`run_command`, `delete_file`, and `git_commit`** each show a modal
  confirmation dialog before running/executing — the agent cannot
  perform these actions silently, but still use with care.
- **`fetch_url` makes outbound network requests** to whatever URL the
  model chooses (http/https only, GET only, 100KB response cap, 15s
  timeout, and up to five HTTP redirects). There is no domain allowlist
  yet — treat this like giving the agent limited internet access.
- **`web_search` also makes outbound network requests**, by default to
  `https://duckduckgo.com/html/?q=%s` (HTML scraped with a regex — no
  official API, so result quality/availability isn't guaranteed).
  Override `aiAgentChat.webSearchUrl` to point at an internal search
  engine if public DuckDuckGo isn't reachable from your network.

---

## Usage

1. Click the **AI Agent** icon in the Activity Bar (or run
   `AI Agent Chat: Open`).
2. Pick a model from the dropdown at the top (🔄 refreshes the list from
   the server, ⏱ benchmarks response time per model).
3. Type your question in the input box and press **Enter** (or **Send**).
4. The agent streams its answer and may invoke tools (file, git, web,
   or VS Code UI tools — see Features above); tool output is shown
   inline. Destructive actions (`run_command`, `delete_file`,
   `git_commit`) prompt for confirmation first.
5. The Send button is disabled while the agent is running; use **Stop**
   to cancel the in-flight request/agent loop before the answer arrives.
   The Send button re-enables when the run completes or is stopped.

---

## Building

Full toolchain (Node.js + npm required). All targets run a clean build:
preflight checks → clean `out/` + old `*.vsix` → `npm ci` → `tsc` →
`vsce package`.

```bash
npm run compile                 # tsc only (fast, no package)
npm run build                   # clean build + produce .vsix
npm run build -- --skip-install # reuse node_modules (fast clean build)
npm run build -- --install      # build, package, and install into VS Code
```

On Windows you can also use `.\build.ps1` (wraps `node build.js`).

Install the produced `.vsix` manually:

```
code --install-extension ai-agent-chat-<version>.vsix
```

> Packaging note: set a real `publisher` in `package.json` before
> publishing to the Marketplace (the build passes
> `--allow-missing-repository` for local packaging only).

---

## Project Layout

```
src/extension.ts     Activation, key normalization + one-time migration,
                     history management, model fetching/benchmarking
src/chatPanel.ts     ChatViewProvider (sidebar WebviewView, CSP + nonce,
                     incremental deltas, done-signal, renderHistory)
src/agent.ts         Agent loop (configurable maxSteps, default 15) and
                     an auto-generated system prompt (buildSystemPrompt
                     derives the tool list from tools.ts instead of a
                     hardcoded string); tool schemas/execution live in
                     src/tools.ts
src/tools.ts         Full tool set (file, git, web, VS Code UI, shell)
                     with path containment and confirmation prompts for
                     destructive actions
src/test/            Tests (node:test): pure-function unit tests (path
                     containment, URL validation, search result parsing,
                     Unix-command detection), file-tool integration tests
                     that create/read/rename/delete real files in a temp
                     directory via executeTool(), tests for edit_file/
                     find_files/get_diagnostics/get_active_editor/
                     read_file_lines/get_symbols/format_document/
                     run_in_terminal, and live-network tests that call
                     fetch_url/web_search for real (self-skip if the
                     network/search engine is unreachable)
src/apiClient.ts     Hand-rolled HTTP client (no runtime deps), Bearer
                     auth, TLS verification ON, 120s timeout, listModels()
                     for model discovery, AbortSignal support for stop
build.js             Clean build pipeline (preflight/clean/compile/package)
build.ps1            Windows wrapper for build.js
bundle.js            Generates project-bundle.md documentation
```

---

## Development Notes

- TypeScript compiles to `out/` with source maps (`sourceMap: true`).
- No runtime npm dependencies; devDependencies are `@types/node`,
  `@types/vscode`, `typescript`, and `@vscode/vsce`.
- npm registry points to the internal Huawei mirror (`.npmrc`) with
  `audit=false` and `fund=false` to avoid interactive prompts.
- Run `npm test` to compile and execute tests for `src/tools.ts`, using
  Node's built-in `node:test` runner (no test framework dependency). A
  minimal `vscode` module stub (`test/vscode-stub.js`, wired up via
  `test/register-vscode-stub.js`) lets these run outside the VS Code
  extension host — it includes a real (simplified) glob engine for
  `find_files`/`search_in_files`, and configurable hooks for diagnostics,
  the active editor, `commands.executeCommand` (used by `get_symbols`/
  `format_document`), and terminal `sendText` calls (`run_in_terminal`).
  Four suites:
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
  Tool bodies that call other real `vscode` UI APIs (quick pick, input
  box) or git are still not covered by these tests.

---

## Known Limitations / Roadmap

- [ ] `run_command` approval prompt before executing
- [ ] Move API key from settings to `SecretStorage`
- [ ] TLS verification as a configurable setting (`aiAgentChat.tlsVerify`, default true)
- [ ] Optional editor-tab chat mode (floating panel) alongside the sidebar view
- [ ] Markdown rendering in chat messages (currently plain text)
- [ ] Chat history re-render survives webview reload (`renderHistory` support exists in the view; wire it up on resolve)

---

## Versioning

Every change to this extension bumps the **minor** version in
`package.json` (e.g. `0.5.0` → `0.6.0`), then rebuilds/repackages/
reinstalls the `.vsix`. This README is kept in sync with each change.

---

## License

MIT — see the LICENSE file in the repository root.

# AI Agent Chat — VSCode Extension (Remote-SSH ready)

Agentic chat extension for any OpenAI-compatible API.

## Features
- Chat panel (Webview) inside VS Code
- Connects to any OpenAI-compatible base URL + API key
- First-run onboarding: prompts for Base URL and API key, saves to workspace settings
- Direct connection: ignores HTTP_PROXY / HTTPS_PROXY
- TLS certificate verification:DISABLED (rejectUnauthorized: false)
- Agentic tools: read_file, write_file, run_command
- Remote-SSH ready: runs on the remote machine (extensionKind: workspace),
  so file and command tools operate on the remote filesystem
- Live-updating assistant output with tool-run notifications
- Conversation history trimmed to last 20 messages

## Build
    npm install
    npm run compile

## Package as .vsix
    npx @vscode/vsce package

## Install
1. Open VS Code (connect via Remote-SSH if desired) and open a workspace folder
2. Extensions -> ... -> Install from VSIX
   (when connected via SSH, install into the "SSH: hostname" section)
3. On first run of the "AI Agent: Open Chat" command the extension prompts
   for Base URL and API key.
   Values are saved to .vscode/settings.json in the workspace
   (on the remote filesystem when using Remote-SSH).
4. To change settings later: Settings -> AI Agent Chat
   (use the Remote [SSH: hostname] tab when connected).

## Remote behavior
- The extension runs in the remote extension host. All API calls originate
  from the remote machine's network. TLS certificate verification is
  intentionally DISABLED (rejectUnauthorized: false) for internal endpoints
  that use self-signed certificates.
- run_command executes on the remote machine in the workspace root.

## Security warning
TLS verification should be disabled. 

## Project layout
- src/extension.ts  — command registration, onboarding, glue
- src/chatPanel.ts  — Webview chat UI
- src/agent.ts      — agentic loop + tool execution
- src/apiClient.ts  — HTTPS client (no proxy; TLS verification ON)
- build.js          — packaging helper (npm run build / build:fast / build:install)

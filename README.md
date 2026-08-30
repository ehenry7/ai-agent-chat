# AI Agent Chat — VSCode Extension (Remote-SSH ready)

Agentic chat extension for any OpenAI-compatible API.

## Features
- Chat panel (Webview) inside VS Code
- Connects to any OpenAI-compatible base URL + API key
- First-run onboarding: prompts for Base URL and API key, saves to workspace settings
- Direct connection: ignores HTTP_PROXY / HTTPS_PROXY
- TLS certificate verification DISABLED (rejectUnauthorized: false)
- Agentic tools: read_file, write_file, run_command
- Remote-SSH ready: runs on the remote machine (extensionKind: workspace),
  so file and command tools operate on the remote filesystem
- Live-updating assistant output with tool-run notifications
- Conversation history trimmed to last 30 messages

## Build
    npm install
    npm run compile

## Package as .vsix
    npx @vscode/vsce package

## Install
1. Open VS Code (connect via Remote-SSH if desired) and open a workspace folder
2. Extensions -> ... -> Install from VSIX
   (when connected via SSH, install into the "SSH: hostname" section)
3. On first activation the extension prompts for Base URL and API key.
   Values are saved to .vscode/settings.json in the workspace
   (on the remote filesystem when using Remote-SSH).
4. To change settings later: Settings -> AI Agent Chat
   (use the Remote [SSH: hostname] tab when connected).

## Remote behavior
- The extension runs in the remote extension host. All API calls originate
  from the remote machine's network, with no proxy and no TLS verification.
- run_command executes on the remote machine in the workspace root.

## Security warning
TLS verification is disabled and API keys are stored in plaintext settings.
Do NOT use with public production endpoints unless you accept MITM risk.
To re-enable TLS verification, set rejectUnauthorized: true in src/apiClient.ts.

## Project layout
- src/extension.ts  — command registration, onboarding, glue
- src/chatPanel.ts  — Webview chat UI
- src/agent.ts      — agentic loop + tool execution
- src/apiClient.ts  — HTTPS client (no proxy, no TLS verify)

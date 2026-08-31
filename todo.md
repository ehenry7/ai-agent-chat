# TODO — Port Recommended Tools from Roo Code (`C:\work\HuaweiCodingAssistant\src`)

This file tracks the recommended tools to port into our agent (`src/tools.ts` + `src/agent.ts`),
with the **actual implementation details extracted from the reference repo** so each task is
actionable. Our tools are a static `tools` array in `src/tools.ts` plus a big `executeTool(name, args)`
`switch`. New tools slot in by (1) adding a tool definition to the `tools` array and (2) adding a
`case` to `executeTool`. Some recommendations (new_task, update_todo_list, run_slash_command) also
need agent-loop / session-state changes in `src/agent.ts`.

Reference repo layout (all paths below are relative to `C:\work\HuaweiCodingAssistant\src`):
- Tool **definitions** (name + JSON schema shown to the model): `core/prompts/tools/native-tools/*.ts`
- Tool **implementations** (execution logic): `core/tools/*.ts` (each extends `BaseTool<TName>`)

---

## Checklist

- [ ] 1. `apply_patch` — multi-file create/delete/update patch tool
- [ ] 2. `apply_diff` — multi-block SEARCH/REPLACE diff tool (fuzzy matching)
- [ ] 3. `new_task` — spawn a sub-agent in a chosen mode
- [ ] 4. `update_todo_list` — step-by-step task tracking
- [ ] 5. `search_replace` — strict single-occurrence search/replace (lower priority; overlaps `edit_file`)
- [ ] 6. `run_slash_command` — execute predefined slash-command templates

---

## 1. `apply_patch` — multi-file create / delete / update patch

**What it does:** Apply a single text `patch` that can create, delete, update, and rename **multiple
files** in one call, using a stripped-down, file-oriented diff format (the Codex `apply_patch`
spec). The only multi-file atomic edit tool — great for refactors touching many files.

### Reference files
| File | Role |
|---|---|
| `core/prompts/tools/native-tools/apply_patch.ts` | Tool definition: `params: { patch: string }` |
| `core/tools/apply-patch/parser.ts` | `parsePatch(patch)` → structured `Hunk[]` |
| `core/tools/apply-patch/seek-sequence.ts` | `seekSequence()` multi-pass fuzzy line matcher |
| `core/tools/apply-patch/apply.ts` | `applyChunksToContent()`, `processAllHunks()` |
| `core/tools/apply-patch/index.ts` | Re-exports |
| `core/tools/ApplyPatchTool.ts` | Tool wrapper (approval, diff view, file I/O) |

### Patch grammar (from `parser.ts`)
```
Patch   := "*** Begin Patch" NEWLINE { FileOp } "*** End Patch" NEWLINE
FileOp  := AddFile | DeleteFile | UpdateFile
AddFile := "*** Add File: " path NEWLINE { "+" line NEWLINE }
Delete  := "*** Delete File: " path NEWLINE
Update  := "*** Update File: " path NEWLINE [ "*** Move to: " newPath NEWLINE ] { Hunk }
Hunk    := "@@" [ context ] NEWLINE { HunkLine } [ "*** End of File" NEWLINE ]
HunkLine:= (" " | "-" | "+") text NEWLINE
```
- Parsed output `Hunk` is a union: `AddFile{path, contents}` | `DeleteFile{path}` |
  `UpdateFile{path, movePath|null, chunks[]}`.
- `UpdateFileChunk = { changeContext: string|null, oldLines: string[], newLines: string[], isEndOfFile: boolean }`.
  - ` ` prefix = context line (copied to both old & new)
  - `+` = added (newLines only)
  - `-` = removed (oldLines only)
  - `@@ <text>` = optional change-context anchor to narrow the search
  - `*** End of File` = old_lines must match at end of file
- Lenient mode: heredoc-wrapped patches `<<EOF ... EOF` are unwrapped before parsing.
- `checkPatchBoundaries()` enforces first line `*** Begin Patch` / last line `*** End Patch`.

### Matching algorithm (`seek-sequence.ts`)
`seekSequence(lines, pattern, start, eof): number | null` tries **4 passes of decreasing strictness**:
1. Exact match
2. Trim trailing whitespace (`trimEnd`)
3. Trim both sides (`trim`)
4. Unicode-normalized — maps typographic chars (curly quotes `""''`, em/en dashes, NBSP) to ASCII
   so patches written in plain ASCII match source containing fancy punctuation.

When `eof === true`, it searches from `lines.length - pattern.length` (end-anchored) first, then
falls back to searching from `start`. Returns `null` if `pattern.length > lines.length`.

### Apply algorithm (`apply.ts`)
- `computeReplacements(originalLines, filePath, chunks)`: for each chunk, if `changeContext` is set,
  seek it first to advance `lineIndex`; pure additions (`oldLines` empty) insert before a trailing
  empty line; otherwise `seekSequence` finds `oldLines`, with a retry that strips a trailing empty
  line. Collects `[startIndex, oldLen, newLines]` replacements, sorted by start index.
- `applyReplacements(lines, replacements)`: splices each replacement **in reverse order** so earlier
  edits don't shift later indices.
- `applyChunksToContent(content, filePath, chunks)`: splits on `\n`, drops the trailing empty element
  from the final newline, applies replacements, re-adds a trailing newline, joins with `\n`.
- `processHunk(hunk, readFile)` / `processAllHunks(hunks, readFile)` produce
  `ApplyPatchFileChange[]` = `{ type:"add"|"delete"|"update", path, movePath?, originalContent?, newContent? }`.
  `readFile` is injected (in the wrapper it's `path.resolve(task.cwd, filePath)` + `fs.readFile`).

### Tool wrapper behavior (`ApplyPatchTool.ts`)
1. Validate `patch` present; `parsePatch(patch)` (catch `ParseError` → tool error).
2. `processAllHunks(parsed.hunks, readFile)` (catch → tool error, increment mistake count).
3. For each change: resolve absolute path, `rooIgnore` access check, `rooProtected` write-protect check,
   then dispatch:
   - **add**: reject if file already exists ("Use Update File instead"); diff view / approval; save;
     track file context.
   - **delete**: reject if missing; approval; `fs.unlink`.
   - **update**: reject if missing; compute `createPrettyPatch(relPath, original, new)`; if empty diff →
     "No changes needed"; diff view / approval; **if `movePath`**: validate destination access/protect/
     inside-workspace, write new content to `movePath`, `fs.unlink` old path; else save in place.
4. `handlePartial()` streams a preview (extracts the first `*** Add/Delete/Update File:` path from
   the partial patch for display).

### Porting notes for our codebase
- Add tool def `apply_patch` with `{ patch: string }` to `src/tools.ts` `tools[]`.
- Port `apply-patch/` (parser.ts, seek-sequence.ts, apply.ts) as a self-contained module under e.g.
  `src/tools/apply-patch/` — it has **no Roo-specific deps** (pure TS), so it ports almost verbatim.
  Drop the `import type` from `@roo-code/types` if any; the module is otherwise standalone.
- Add an `apply_patch` `case` to `executeTool` that: resolves paths with our `resolveInWorkspace`
  (containment check), reads/writes via `fs`, and returns a textual summary. We have no diff-view /
  approval UI like theirs, so skip the `askApproval`/`diffViewProvider` steps (or gate writes behind
  our existing `showWarningMessage` confirmation pattern used by `delete_file`/`git_commit`).
- Reuse our existing `resolveInWorkspace` for path containment instead of their `isPathOutsideWorkspace`.
- Sub-tasks:
  - [ ] Port `parser.ts` (`parsePatch`, `ParseError`, `Hunk`/`UpdateFileChunk`/`ApplyPatchArgs` types)
  - [ ] Port `seek-sequence.ts` (`seekSequence` + `normalizeUnicode`)
  - [ ] Port `apply.ts` (`applyChunksToContent`, `processHunk`, `processAllHunks`, `ApplyPatchError`)
  - [ ] Add `apply_patch` tool definition + `executeTool` case
  - [ ] Add unit tests (mirror `core/tools/__tests__/applyPatchTool.partial.spec.ts`)

---

## 2. `apply_diff` — multi-block SEARCH/REPLACE diff (fuzzy matching)

**What it does:** Surgical edits to a single file using one or more `<<<<<<< SEARCH … >>>>>>> REPLACE`
blocks in one call. Uses fuzzy (Levenshtein) matching + indentation preservation so it tolerates minor
drift better than a literal replace. This is the Aider-style high-precision editing idiom.

### Reference files
| File | Role |
|---|---|
| `core/prompts/tools/native-tools/apply_diff.ts` | Tool definition: `params: { path, diff }` |
| `core/diff/strategies/multi-search-replace.ts` | `MultiSearchReplaceDiffStrategy.applyDiff()` engine |
| `core/tools/ApplyDiffTool.ts` | Tool wrapper |
| `integrations/misc/extract-text.ts` | `addLineNumbers`, `stripLineNumbers`, `everyLineHasLineNumbers` |
| `utils/text-normalization.ts` | `normalizeString` (smart-quote normalization) |

### Diff block format (from the tool description)
```
<<<<<<< SEARCH
:start_line:[line_number]
-------
[exact content to find]
=======
[new content to replace with]
>>>>>>> REPLACE
```
- `:start_line:` is **required** (starting line number of the original content).
- Multiple SEARCH/REPLACE blocks allowed in one `diff` string.
- Markers inside content must be escaped with a leading backslash (`\<<<<<<<`, `\=======`, `\>>>>>>>`).

### Engine: `MultiSearchReplaceDiffStrategy` (`multi-search-replace.ts`)
Implements `DiffStrategy.applyDiff(originalContent, diffContent, _startLine?): Promise<DiffResult>`.

1. **`validateMarkerSequencing(diffContent)`** — a 3-state machine (`START → AFTER_SEARCH → AFTER_SEPARATOR`)
   that walks line-by-line and produces precise errors for: missing/extra `=======`, `>>>>>>> REPLACE`
   out of order, unescaped merge-conflict markers found in content (tells the model to escape them),
   and `:start_line:`/`:end_line:` illegally placed in the REPLACE section. `SEARCH` pattern tolerates
   an optional trailing `>` (some models emit `<<<<<<< SEARCH>`).
2. **`unescapeMarkers(content)`** — `^\\<<<<<<<` → `<<<<<<<`, etc.
3. **Block extraction** — one big regex with negative lookbehinds for unescaped markers captures, per
   block: optional `:start_line:` (group 2), optional `:end_line:` (group 4), optional `-------`,
   `searchContent` (group 6), `replaceContent` (group 7).
4. **Per-block apply** (blocks sorted by `startLine`):
   - Unescape markers; if every line has line numbers, strip them (`stripLineNumbers`) and derive
     `startLine` from the first line.
   - Reject identical search/replace; reject empty search.
   - **Matching:** try exact match at the given `startLine` first; if similarity < threshold, run
     `fuzzySearch()` (middle-out from the midpoint within a `±BUFFER_LINES=40` window).
     - `getSimilarity(original, search)` = `1 - levenshteinDistance / maxLen` after `normalizeString`
       (normalizes smart quotes). Threshold `fuzzyThreshold` (default `1.0` = exact; UI inverts it).
   - **Aggressive fallback:** if still no match, strip line numbers aggressively and retry the
     middle-out search. On failure, build a detailed error with similarity %, the best match found
     (line-numbered), and surrounding original content (line-numbered).
   - **Indentation preservation:** compute the matched lines' leading whitespace vs. the search
     block's base indent, then re-indent each replacement line relative to that base (handles
     tab/space mixes; adjusts for negative relative levels).
   - Splice: `resultLines = beforeMatch + indentedReplaceLines + afterMatch`; track `delta`
     (line-count change) to offset subsequent blocks' `startLine`.
5. Returns `DiffResult = { success, content, failParts?: DiffResult[] }`. If zero blocks applied,
   `{ success:false, failParts }`; if some applied, `{ success:true, content, failParts }`.
6. `getProgressStatus()` reports `applied/total` SEARCH-block counts for the UI.

### Tool wrapper behavior (`ApplyDiffTool.ts`)
1. Validate `path` + `diff`; HTML-unescape `diff` unless model is Claude (`unescapeHtmlEntities`).
2. `rooIgnore` check; resolve path; ensure file exists; read `originalContent`.
3. `task.diffStrategy.applyDiff(originalContent, diffContent, startLineFromRegex)`; on failure,
   increment per-path mistake counter, surface `failParts` errors, and (after 2 fails) notify the user.
4. On success: build a unified diff for display (`createPrettyPatch`), diff view + approval, save,
   track file context. Appends a notice if only a single SEARCH block was used ("making multiple
   related changes in one apply_diff is more efficient").
5. `handlePartial()` waits for the path to stabilize (`hasPathStabilized`) before showing UI.

### Porting notes for our codebase
- The engine (`multi-search-replace.ts`) depends on: `fastest-levenshtein` (`distance`), their
  `normalizeString`, and `extract-text` line-number helpers. Port those three small helpers too
  (or reimplement: `distance` via a tiny Levenshtein, `normalizeString` = smart-quote map).
- Add tool def `apply_diff` with `{ path: string, diff: string }`.
- Add an `apply_diff` `case` to `executeTool`: read file via `resolveInWorkspace`, call the ported
  `applyDiff(originalContent, diffContent)`, write `result.content` back on success, and return a
  summary that includes any `failParts` errors (their error messages are excellent — keep them).
- We don't need the `DiffStrategy` abstraction; a standalone `applyDiff()` function is enough.
- `:start_line:` is "required" in their prompt but the engine treats 0/missing as "search from start";
  keep that leniency.
- Sub-tasks:
  - [ ] Port `normalizeString` (smart-quote/punctuation normalization)
  - [ ] Port `addLineNumbers` / `stripLineNumbers` / `everyLineHasLineNumbers` helpers
  - [ ] Port `MultiSearchReplaceDiffStrategy.applyDiff` as a standalone `applyDiff()` (add a small
        Levenshtein if not adding `fastest-levenshtein` dependency)
  - [ ] Port `validateMarkerSequencing` (gives high-quality model-facing errors)
  - [ ] Add `apply_diff` tool definition + `executeTool` case
  - [ ] Tests: well-formed multi-block, fuzzy match, indentation preservation, escaped markers,
        malformed-marker errors

---

## 3. `new_task` — spawn a sub-agent in a chosen mode

**What it does:** Create a new task (sub-agent) instance in a chosen **mode** with a message and an
optional initial todo list, enabling divide-and-conquer / delegated subtasks. **Must be called alone**
(not alongside other tools in the same turn).

### Reference files
| File | Role |
|---|---|
| `core/prompts/tools/native-tools/new_task.ts` | Tool definition: `params: { mode, message, todos? }` |
| `core/tools/NewTaskTool.ts` | Tool wrapper |
| `core/tools/UpdateTodoListTool.ts` | Exports `parseMarkdownChecklist` (reused here) |
| `shared/modes.ts` | `getModeBySlug(mode, customModes)` |

### Tool definition (`new_task.ts`)
- `mode` (required): slug of the mode to start in (e.g. `code`, `debug`, `architect`).
- `message` (required): initial user instructions / context for the new task.
- `todos` (optional, `string|null`): initial todo list as a markdown checklist; required when the
  workspace mandates todos.
- Prompt note: "CRITICAL: This tool MUST be called alone. Do NOT call this tool alongside other tools
  in the same message turn."

### Tool wrapper behavior (`NewTaskTool.ts`)
1. Validate `mode` and `message` (missing → mistake + missing-param error; set `didToolFailInCurrentTurn`).
2. Read VSCode setting `<Package.name>.newTaskRequireTodos` (default `false`); if true and `todos`
   is `undefined`, error. (`undefined` = not provided; empty string is valid.)
3. If `todos` provided, `parseMarkdownChecklist(todos)` → `TodoItem[]` (imported from
   `UpdateTodoListTool`); bad format → tool error.
4. Un-escape one level of backslashes before `@` for hierarchical subtasks: `message.replace(/\\\\@/g, "\\@")`.
5. `getModeBySlug(mode, state.customModes)` → invalid mode → tool error.
6. `askApproval("tool", JSON.stringify({ tool:"newTask", mode, content, todos }))`.
7. On approval: `child = await provider.delegateParentAndOpenChild({ parentTaskId: task.taskId,
   message: unescapedMessage, initialTodos: todoItems, mode })`.
8. `pushToolResult("Delegated to child task " + child.taskId)`. (No pause/unpause, no waiting.)
9. `handlePartial()` streams `{tool:"newTask", mode, content, todos}`.

### Architectural dependencies (this is the big one)
`new_task` is **not** a standalone tool — it depends on:
- A **Task / sub-task tree** with parent→child delegation (`provider.delegateParentAndOpenChild`).
- A **modes** system (`getModeBySlug`, per-mode role definitions / tool groups). We currently have a
  single mode (no `mode` concept at all).
- Session state that outlives a single `runAgent` call (`task.taskId`, todo lists, history).

### Porting notes for our codebase
This requires real architecture work before the tool is useful:
- [ ] Introduce a `mode` concept (at minimum a set of named modes with role-prompt + allowed-tools).
- [ ] Add a sub-agent/task abstraction: a parent agent can spawn a child `runAgent` with its own
      message history + todo list, and the parent receives the child's final result.
- [ ] Add `delegateParentAndOpenChild`-equivalent in our agent layer (`src/agent.ts` /
      `src/chatPanel.ts`).
- [ ] Reuse `parseMarkdownChecklist` from task 4 (update_todo_list).
- [ ] Add `new_task` tool definition + `executeTool` case (validate, spawn child, return child id).
- [ ] Enforce "call alone" — our loop already processes a batch of tool_calls; either reject
      `new_task` when other calls are present in the same assistant turn, or run it solo.

---

## 4. `update_todo_list` — step-by-step task tracking

**What it does:** Replace the entire TODO checklist with an updated one reflecting current state.
Enables the model to track multi-step tasks, mark progress, and dynamically add discovered todos.
The list is reflected back to the model each turn via an environment block.

### Reference files
| File | Role |
|---|---|
| `core/prompts/tools/native-tools/update_todo_list.ts` | Tool definition: `params: { todos: string }` |
| `core/tools/UpdateTodoListTool.ts` | Tool wrapper + `parseMarkdownChecklist` + helpers |
| `core/environment/getEnvironmentDetails.ts` | Appends the todo "reminder" block to each turn |
| `core/environment/reminder.ts` | `formatReminderSection(todoList)` — renders the list to the model |
| `shared/todo.ts` | `getLatestTodo(messages)` (restore on resume) |
| `@roo-code/types` | `TodoItem`, `TodoStatus`, `todoStatusSchema` |

### Tool definition (`update_todo_list.ts`)
- `todos` (required, string): full markdown checklist in execution order.
  - `[ ]` = pending, `[x]` = completed, `[-]` = in progress.
  - Single-level only (no nesting/subtasks). List in intended execution order.
- Principles in the prompt: confirm completion before marking done; may update multiple statuses at
  once; add new items as discovered; keep unfinished tasks unless told to remove.
- Examples show the before/after markdown.

### Tool wrapper behavior (`UpdateTodoListTool.ts`)
1. `parseMarkdownChecklist(todosRaw)` (bad format → tool error, set `didToolFailInCurrentTurn`).
2. `validateTodos(todos)`: must be array; each item needs string `id`, string `content`, valid
   `status` (checked against `todoStatusSchema.options`).
3. `normalizeStatus()`: maps anything to `pending` | `in_progress` | `completed`.
4. `askApproval("tool", JSON.stringify({tool:"updateTodoList", todos}))` — **the user can edit the
   list** in the approval UI; edits are captured via a module-level `approvedTodoList` snapshot and
   re-applied (`isTodoListChanged` → use the approved version, emit `user_edit_todos`).
5. `setTodoListForTask(task, normalizedTodos)` → stores `task.todoList`.
6. Result: "Todo list updated successfully." or "User edits todo:\n\n" + markdown if the user changed it.

### `parseMarkdownChecklist(md)` (the reusable parser)
```ts
// per line, after trim + filter(Boolean):
match = line.match(/^(?:-\s*)?\[\s*([ xX\-~])\s*\]\s+(.+)$/)
// [x]/[X] -> "completed"; [-]/[~] -> "in_progress"; else "pending"
id = md5(content + status)   // stable id across updates
return { id, content, status }
```
Returns `TodoItem[]`. Tolerates an optional leading `- `.

### Helper functions (also in `UpdateTodoListTool.ts`)
- `addTodoToTask(task, content, status="pending", id?)` — push a new item.
- `updateTodoStatusForTask(task, id, nextStatus)` — enforces transitions:
  `pending→in_progress`, `in_progress→completed`, or same-status; returns `false` otherwise.
- `removeTodoFromTask(task, id)`, `getTodoListForTask(task)`, `setTodoListForTask(task, todos?)`,
  `restoreTodoListForTask(task, todoList?)` (falls back to `getLatestTodo(messages)`).
- `todoListToMarkdown(todos)`: `[ ]`/`[x]`/`[-]` + content, joined by `\n`.

### How the list reaches the model each turn
- `getEnvironmentDetails()` (called after each tool round) builds an `<environment_details>` block
  and appends `formatReminderSection(task.todoList)` when `todoListEnabled` is on (default true).
- `formatReminderSection()` (`reminder.ts`):
  - Empty/no list → `"You have not created a todo list yet. Create one with update_todo_list if your
    task is complicated or involves multiple steps."`
  - Non-empty → a markdown table `| # | Content | Status |` (statuses humanized: Pending / In
    Progress / Completed), followed by: "IMPORTANT: When task status changes, remember to call the
    `update_todo_list` tool to update your progress."

### Porting notes for our codebase
This is a self-contained, high-ROI addition:
- [ ] Define `TodoItem = { id: string; content: string; status: "pending"|"in_progress"|"completed" }`.
- [ ] Port `parseMarkdownChecklist`, `validateTodos`, `normalizeStatus`, `todoListToMarkdown` (pure
      functions — port verbatim; swap `crypto` md5 for Node `crypto.createHash("md5")`).
- [ ] Add **session state** for the todo list. Our `runAgent` is stateless across calls; thread a
      `todoList` through `ToolContext` (extend `ToolContext` in `src/tools.ts` with
      `getTodoList()/setTodoList()`), or store it on the chat panel session in `src/chatPanel.ts`.
- [ ] Add `update_todo_list` tool definition + `executeTool` case (parse → validate → store).
- [ ] Inject the reminder block: add a per-turn "environment" trailer in `src/agent.ts` that appends
      `formatReminderSection(todoList)` to the tool-result / next user message (mirror
      `getEnvironmentDetails` → `reminder.ts`). Gated by a `todoListEnabled` setting.
- [ ] (Optional) Reuse the same parser for `new_task`'s `todos` param (task 3).

---

## 5. `search_replace` — strict single-occurrence search/replace (lower priority)

**What it does:** Replace **one** occurrence of `old_string` with `new_string` in a file. Enforces
strict uniqueness (the prompt demands 3–5 lines of context before/after) and rejects multiple matches.

> ⚠️ **Overlap:** This is essentially our existing `edit_file` (without `replaceAll`) with a more
> prescriptive prompt. Lower priority — consider porting only its prompt wording / error messages to
> sharpen our `edit_file`, rather than adding a separate tool.

### Reference files
| File | Role |
|---|---|
| `core/prompts/tools/native-tools/search_replace.ts` | Tool definition: `{ file_path, old_string, new_string }` |
| `core/tools/SearchReplaceTool.ts` | Tool wrapper |

### Tool definition (`search_replace.ts`)
- `file_path` (required): relative or absolute path.
- `old_string` (required): must be unique within the file; must match exactly including whitespace.
- `new_string` (required): must differ from `old_string`.
- Prompt rules: include 3–5 lines of context before AND after; single instance only; for multiple
  instances make separate calls.

### Tool wrapper behavior (`SearchReplaceTool.ts`)
1. Validate `file_path`, `old_string`, `new_string`; reject `old_string === new_string`.
2. Resolve relative/absolute path; `rooIgnore` + `rooProtected` checks; ensure file exists.
3. Read file; **normalize CRLF → LF** for consistent matching (`fileContent.replace(/\r\n/g, "\n")`).
4. Normalize `old_string`/`new_string` CRLF → LF too.
5. `matchCount = fileContent.split(normalizedOldString).length - 1`:
   - `0` → "No match found … ensure it matches exactly, including whitespace and indentation."
   - `>1` → "Found N matches … can only replace ONE occurrence … provide more context (3-5 lines
     before and after)."
6. Exactly 1 → `fileContent.replace(old, new)`; if no change → "No changes needed"; else diff view +
   approval + save + track file context.
7. `handlePartial()` previews "replacing: \"<first 50 chars>…\"".

### Porting notes for our codebase
- Our `edit_file` already does: CRLF/LF normalization (via `fileIsCrlf` heuristic), uniqueness check
  (rejects multiple matches unless `replaceAll`), and "search text not found" / "matches N locations"
  errors. So the **logic is already present**.
- Worth borrowing: their explicit "include 3–5 lines of context before and after" guidance in the
  tool description, and their `old_string === new_string` guard. Add the latter to `edit_file`.
- [ ] (Optional) Add `old_string === new_string` rejection to our `edit_file`.
- [ ] (Optional) Enrich our `edit_file` description with the 3–5-lines-of-context guidance.
- [ ] Only add a separate `search_replace` tool if we want the model to have a deliberately stricter
      single-replace primitive distinct from `edit_file`+`replaceAll`.

---

## 6. `run_slash_command` — execute predefined slash-command templates

**What it does:** Execute a named slash command to inject a predefined instruction template / content
into the conversation (e.g. `/init` analyzes the codebase and writes `AGENTS.md`). Commands are
markdown files (built-in, global, or project-scoped) with optional YAML frontmatter. Gated by an
experiment flag in the reference repo.

### Reference files
| File | Role |
|---|---|
| `core/prompts/tools/native-tools/run_slash_command.ts` | Tool definition: `{ command, args? }` |
| `core/tools/RunSlashCommandTool.ts` | Tool wrapper |
| `services/command/commands.ts` | Command registry: discovery, loading, frontmatter parsing |
| `services/command/built-in-commands.ts` | Built-in command definitions (the command list) |
| `services/command/__tests__/*.spec.ts` | Tests for frontmatter / symlink / built-in commands |

### Tool definition (`run_slash_command.ts`)
- `command` (required, string): name of the slash command (e.g. `init`, `test`, `deploy`).
- `args` (optional, `string|null`): additional context/arguments for the command.
- Description: "Execute a slash command to get specific instructions or content. Slash commands are
  predefined templates that provide detailed guidance for common tasks."

### Tool wrapper behavior (`RunSlashCommandTool.ts`)
1. **Experiment gate:** if `RUN_SLASH_COMMAND` experiment is disabled → tool error telling the user to
   enable it in Experimental Settings. (We can drop this gate or make it always-on.)
2. Validate `command` present.
3. `command = await getCommand(task.cwd, commandName)`.
4. **If not found:** try a **skill fallback** — `resolveSkillContentForMode(skillsManager,
   commandName, currentMode)`; if a skill matches, approve + return its content via
   `buildSkillResult`. Otherwise → tool error: `"Command '<name>' not found. Available commands:
   <getCommandNames(cwd).join(', ')>"`.
5. **If found:** `askApproval("tool", {tool:"runSlashCommand", command, args, source, description, mode})`.
6. **Mode switch:** if the command's frontmatter sets `mode`, switch to it
   (`provider.handleModeSwitch(command.mode)`).
7. Build the result string: `Command: /<name>` + optional `Description` / `Argument hint` / `Mode` /
   `Provided arguments` / `Source`, then `--- Command Content ---` + the command's markdown body.
8. `pushToolResult(result)` — i.e. the command's content is returned as the tool result, injecting the
   template into the conversation for the model to act on.

### Command registry (`services/command/commands.ts`)
- `interface Command { name; content; source: "global"|"project"|"built-in"; filePath; description?;
  argumentHint?; mode? }`
- **Priority order: project > global > built-in** (later sources override earlier; stored in a `Map`
  keyed by name).
- `getCommands(cwd)`: add built-ins, scan `<globalRooDir>/commands`, scan `<projectRooDir>/commands`.
- `getCommand(cwd, name)`: optimized direct lookup — project dir first, then global, then built-in
  (`tryLoadCommand`).
- `getCommandNames(cwd)`: `getCommands().map(c => c.name)` (for autocomplete + the "not found" error).
- **File format:** `.md` files. Parsed with **`gray-matter`** frontmatter:
  - `description` (string)
  - `argument-hint` (string)
  - `mode` (string — triggers a mode switch on run)
  - body = the command content. If frontmatter parsing fails, the whole file is the content.
- **Symlink support:** `resolveCommandSymLink` / `resolveCommandDirectoryEntry` follow symlinks up to
  `MAX_DEPTH = 5` (guards against cyclic symlinks); command name comes from the symlink's filename.
- `getCommandNameFromFile(filename)`: strips the `.md` extension. `isMarkdownFile()`: ends with `.md`.

### Built-in commands list (`services/command/built-in-commands.ts`)
`BUILT_IN_COMMANDS` is a `Record<string, BuiltInCommandDefinition>`. **Currently exactly one built-in
command:**

| Name | Description | Content |
|---|---|---|
| `init` | "Analyze codebase and create concise AGENTS.md files for AI assistants" | A large `<task>…<initialization>…<analysis_workflow>…<output_structure>…<quality_criteria>` prompt template that drives the agent to: discover existing `AGENTS.md` / `.roo/rules-{code,debug,ask,architect}/AGENTS.md` / `.cursorrules` / `CLAUDE.md` / `.github/copilot-instructions.md`; identify the stack; extract build/lint/test commands (especially single-test); map core architecture; document **non-obvious, project-specific** patterns only; and write/update a concise `AGENTS.md` (+ mode-specific files). It explicitly instructs using `update_todo_list` to track the analysis steps. |

Helpers: `getBuiltInCommands()`, `getBuiltInCommand(name)`, `getBuiltInCommandNames()` — each returns
`Command` objects with `source: "built-in"` and `filePath: "<built-in:name>"`.

> **Full command list at runtime** = built-in `init` **+** any `*.md` files the user places in
> `<globalCommandsDir>/commands/` (global) or `<projectDir>/.roo/commands/` (project). Project
> commands override global, which override built-in.

### Porting notes for our codebase
- [ ] Add a `src/services/commands/` module porting `commands.ts`:
  - `interface Command { name; content; source; filePath; description?; argumentHint?; mode? }`.
  - `getCommands(cwd)`, `getCommand(cwd, name)`, `getCommandNames(cwd)`.
  - File discovery: scan two dirs — a global dir (e.g. `~/.ai-agent-chat/commands`) and a project dir
    (e.g. `<workspace>/.ai-agent-chat/commands`). Use our `resolveInWorkspace` for the project dir.
  - Frontmatter parsing: add `gray-matter` as a dependency (or write a tiny YAML-frontmatter parser
    for `description` / `argument-hint` / `mode`).
  - Keep symlink support (or drop it for a first cut — it's a nice-to-have).
- [ ] Port `built-in-commands.ts` with at least the `init` command (copy its template verbatim; it's
      model-facing prompt text). Add more built-ins later (e.g. `test`, `commit`).
- [ ] Add `run_slash_command` tool definition (`{ command, args? }`) to `src/tools.ts`.
- [ ] Add an `executeTool` case: `getCommand(cwd, name)`; on miss return the "not found, available:
      …" error (so the model learns valid names); on hit return the `Command: /<name>\n…\n---
      Command Content ---\n<content>` string (this injects the template into context).
- [ ] (Optional) mode-switch hook — only relevant after task 3's mode system exists; until then,
      ignore the `mode` frontmatter field.
- [ ] (Optional) Surface available command names in the system prompt (built in `src/agent.ts`
      `buildSystemPrompt`) so the model knows what it can call, e.g. an "Available slash commands:
      init, …" line — the reference repo surfaces them only via the not-found error, but listing them
      proactively is better.
- [ ] Tests: mirror `services/command/__tests__/frontmatter-commands.spec.ts` and
      `built-in-commands.spec.ts`.

---

## Suggested implementation order
1. **`update_todo_list`** (task 4) — self-contained, high ROI, gives the agent task tracking. Needs a
   small session-state addition + a per-turn reminder injection.
2. **`apply_patch`** (task 1) — pure-TS engine ports almost verbatim; the only multi-file edit tool.
3. **`apply_diff`** (task 2) — best single-file editing UX (fuzzy + indentation-aware). Port the small
   helpers + the strategy.
4. **`run_slash_command`** (task 6) — command registry + `init` built-in. Extensible and cheap once
   the registry exists.
5. **`new_task`** (task 3) — largest effort; depends on a modes + sub-agent architecture. Defer until
   the above land.
6. **`search_replace`** (task 5) — mostly overlaps `edit_file`; just borrow its prompt wording and the
   `old===new` guard.

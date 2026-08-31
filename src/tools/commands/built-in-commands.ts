import { Command } from "./commands"

interface BuiltInCommandDefinition {
  name: string
  description: string
  argumentHint?: string
  content: string
}

const BUILT_IN_COMMANDS: Record<string, BuiltInCommandDefinition> = {
  config: {
    name: "config",
    description: "Display current workspace and AI agent configuration",
    content: "Display configuration",
  },
  init: {
    name: "init",
    description: "Analyze codebase and create concise AGENTS.md files for AI assistants",
    content: `<task>
Please analyze this codebase and create an AGENTS.md file containing:
1. Build/lint/test commands - especially for running a single test
2. Code style guidelines including imports, formatting, types, naming conventions, error handling, etc.
</task>

<initialization>
  <purpose>
    Create (or update) a concise AGENTS.md file that enables immediate productivity for AI assistants.
    Focus ONLY on project-specific, non-obvious information that you had to discover by reading files.
    
    CRITICAL: Only include information that is:
    - Non-obvious (couldn't be guessed from standard practices)
    - Project-specific (not generic to the framework/language)
    - Discovered by reading files (config files, code patterns, custom utilities)
    - Essential for avoiding mistakes or following project conventions
    
    Usage notes:
    - The file you create will be given to agentic coding agents (such as yourself) that operate in this repository
    - Keep the main AGENTS.md concise - aim for about 20 lines, but use more if the project complexity requires it
    - If there's already an AGENTS.md, improve it
    - If there are Claude Code rules (in CLAUDE.md), Cursor rules (in .cursor/rules/ or .cursorrules), or Copilot rules (in .github/copilot-instructions.md), make sure to include them
    - Be sure to prefix the file with: "# AGENTS.md\\n\\nThis file provides guidance to agents when working with code in this repository."
  </purpose>
  
  <todo_list_creation>
    If the update_todo_list tool is available, create a todo list with these focused analysis steps:
    
    1. Check for existing AGENTS.md files
       CRITICAL - Check these EXACT paths IN THE PROJECT ROOT:
       - AGENTS.md (in project root directory)
       - rules-code/AGENTS.md (relative to project root)
       - rules-debug/AGENTS.md (relative to project root)
       - rules-ask/AGENTS.md (relative to project root)
       - rules-architect/AGENTS.md (relative to project root)
       
       IMPORTANT: All paths are relative to the project/workspace root, NOT system root!
       
       If ANY of these exist:
       - Read them thoroughly
       - CRITICALLY EVALUATE: Remove ALL obvious information
       - DELETE entries that are standard practice or framework defaults
       - REMOVE anything that could be guessed without reading files
       - Only KEEP truly non-obvious, project-specific discoveries
       - Then add any new non-obvious patterns you discover
       
       Also check for other AI assistant rules:
       - .cursorrules, CLAUDE.md, .rules-code, .rules-debug, .rules-ask, .rules-architect
       - .cursor/rules/, .github/copilot-instructions.md
    
    2. Identify stack
       - Language, framework, build tools
       - Package manager and dependencies
    
    3. Extract commands
       - Build, test, lint, run
       - Critical directory-specific commands
    
    4. Map core architecture
       - Main components and flow
       - Key entry points
    
    5. Document critical patterns
       - Project-specific utilities (that you discovered by reading code)
       - Non-standard approaches (that differ from typical patterns)
       - Custom conventions (that aren't obvious from file structure)
    
    6. Extract code style
       - From config files only
       - Key conventions
    
    7. Testing specifics
       - Framework and run commands
       - Directory requirements
    
    8. Compile/Update AGENTS.md files
       - If files exist: AGGRESSIVELY clean them up
         * DELETE all obvious information (even if it was there before)
         * REMOVE standard practices, framework defaults, common patterns
         * STRIP OUT anything derivable from file structure or names
         * ONLY KEEP truly non-obvious discoveries
         * Then add newly discovered non-obvious patterns
         * Result should be SHORTER and MORE FOCUSED than before
       - If creating new: Follow the non-obvious-only principle
       - Create mode-specific files in rules-*/ directories (IN PROJECT ROOT)
       
    Note: If update_todo_list is not available, proceed with the analysis workflow directly without creating a todo list.
  </todo_list_creation>
</initialization>

<analysis_workflow>
  Follow the comprehensive analysis workflow to:
  
  1. **Discovery Phase**:
     CRITICAL - First check for existing AGENTS.md files at these EXACT locations IN PROJECT ROOT:
     - AGENTS.md (in project/workspace root)
     - rules-code/AGENTS.md (relative to project root)
     - rules-debug/AGENTS.md (relative to project root)
     - rules-ask/AGENTS.md (relative to project root)
     - rules-architect/AGENTS.md (relative to project root)
     
     IMPORTANT: The rules-*/ folders should be created in the PROJECT ROOT, not system root!
     
     If found, perform CRITICAL analysis:
     - What information is OBVIOUS and must be DELETED?
     - What violates the non-obvious-only principle?
     - What would an experienced developer already know?
     - DELETE first, then consider what to add
     - The file should get SHORTER, not longer
     
     Also find other AI assistant rules and documentation
     
  2. **Project Identification**: Identify language, stack, and build system
  3. **Command Extraction**: Extract and verify essential commands
  4. **Architecture Mapping**: Create visual flow diagrams of core processes
  5. **Component Analysis**: Document key components and their interactions
  6. **Pattern Analysis**: Identify project-specific patterns and conventions
  7. **Code Style Extraction**: Extract formatting and naming conventions
  8. **Security & Performance**: Document critical patterns if relevant
  9. **Testing Discovery**: Understand testing setup and practices
  10. **Example Extraction**: Find real examples from the codebase
</analysis_workflow>

<output_structure>
  <main_file>
    Create or deeply improve AGENTS.md with ONLY non-obvious information:
    
    If AGENTS.md exists:
    - FIRST: Delete ALL obvious information
    - REMOVE: Standard commands, framework defaults, common patterns
    - STRIP: Anything that doesn't require file reading to know
    - EVALUATE: Each line - would an experienced dev be surprised?
    - If not surprised, DELETE IT
    - THEN: Add only truly non-obvious new discoveries
    - Goal: File should be SHORTER and MORE VALUABLE
    
    Content should include:
    - Header: "# AGENTS.md\\n\\nThis file provides guidance to agents when working with code in this repository."
    - Build/lint/test commands - ONLY if they differ from standard package.json scripts
    - Code style - ONLY project-specific rules not covered by linter configs
    - Custom utilities or patterns discovered by reading the code
    - Non-standard directory structures or file organizations
    - Project-specific conventions that violate typical practices
    - Critical gotchas that would cause errors if not followed
    
    EXCLUDE obvious information like:
    - Standard npm/yarn commands visible in package.json
    - Framework defaults (e.g., "React uses JSX")
    - Common patterns (e.g., "tests go in __tests__ folders")
    - Information derivable from file extensions or directory names
    
    Keep it concise (aim for ~20 lines, but expand as needed for complex projects).
    Include existing AI assistant rules from CLAUDE.md, Cursor rules (.cursor/rules/ or .cursorrules), or Copilot rules (.github/copilot-instructions.md).
  </main_file>
  
  <mode_specific_files>
    Create or deeply improve mode-specific AGENTS.md files IN THE PROJECT ROOT.
    
    CRITICAL: For each of these paths (RELATIVE TO PROJECT ROOT), check if the file exists FIRST:
    - rules-code/AGENTS.md (create rules-code in project root, not system root!)
    - rules-debug/AGENTS.md (relative to project root)
    - rules-ask/AGENTS.md (relative to project root)
    - rules-architect/AGENTS.md (relative to project root)
    
    IMPORTANT: The rules-*/ directories must be created in the current project/workspace root directory,
    NOT at the system root (/) or home directory. All paths are relative to where the project is located.
    
    If files exist:
    - AGGRESSIVELY DELETE obvious information
    - Remove EVERYTHING that's standard practice
    - Strip out framework defaults and common patterns
    - Each remaining line must be surprising/non-obvious
    - Only then add new non-obvious discoveries
    - Files should become SHORTER, not longer
    
    Example structure (ALL IN PROJECT ROOT):
    \`\`\`
    project-root/
    ├── AGENTS.md                    # General project guidance
    ├── src/
    ├── package.json
    └── ... other project files
    \`\`\`
    
    AGENTS.md - ONLY non-obvious coding rules discovered by reading files:
    - Custom utilities that replace standard approaches
    - Non-standard patterns unique to this project
    - Hidden dependencies or coupling between components
    - Required import orders or naming conventions not enforced by linters
    - Hidden or misnamed documentation
    - Counterintuitive code organization
    - Misleading folder names or structures
    - Important context not evident from file structure
    
    Example of non-obvious rules worth documenting:
    \`\`\`
    # Project Coding Rules (Non-Obvious Only)
    - Always use safeWriteJson() from src/utils/ instead of JSON.stringify for file writes (prevents corruption)
    - API retry mechanism in src/api/providers/utils/ is mandatory (not optional as it appears)
    - Provider interface in packages/types/src/ has undocumented required methods
    - Test files must be in same directory as source for vitest to work (not in separate test folder)
    \`\`\`
    
    AGENTS-debug.md - ONLY non-obvious debugging discoveries:
    - Hidden log locations not mentioned in docs
    - Non-standard debugging tools or flags
    - Gotchas that cause silent failures
    - Required environment variables for debugging
    
  </mode_specific_files>
</output_structure>

<quality_criteria>
  - ONLY include non-obvious information discovered by reading files
  - Exclude anything that could be guessed from standard practices
  - Focus on gotchas, hidden requirements, and counterintuitive patterns
  - Include specific file paths when referencing custom utilities
  - Be extremely concise - if it's obvious, don't include it
  - Every line should prevent a potential mistake or confusion
  - Test: Would an experienced developer be surprised by this information?
  - If updating existing files: DELETE obvious info first, files should get SHORTER
  - Measure success: Is the file more concise and valuable than before?
</quality_criteria>

Remember: The goal is to create documentation that enables AI assistants to be immediately productive in this codebase, focusing on project-specific knowledge that isn't obvious from the code structure alone.`,
  },
  help: {
    name: "help",
    description: "List all available commands with descriptions",
    content: `List all available slash commands in this workspace, including:
- Project-specific commands (from .ai-agent-chat/commands/)
- Global commands (from ~/.ai-agent-chat/commands/)
- Built-in commands (config, init, and others)

For each command, show its name, description, and optional argument hint.
Format as a table with columns: Command | Source | Description | Arguments`,
  },
  status: {
    name: "status",
    description: "Show agent status and system diagnostics",
    argumentHint: "[full] for detailed output",
    content: `Provide a comprehensive status report including:

1. **Agent Status**
   - Current step count and max steps limit
   - Active task/plan if any
   - Session message count

2. **Memory Status**
   - Folder memory (AGENTS.md) byte size and line count
   - Global memory (GLOBAL_AGENTS.md) byte size and line count
   - Warnings if approaching 64KB limit

3. **Workspace Status**
   - Workspace root path
   - Git branch (if in repo)
   - Uncommitted changes count
   - Files with diagnostics (errors/warnings count)

4. **Extension Configuration**
   - Base URL and model
   - API key status (set/missing)
   - Max steps setting`,
  },
  memory: {
    name: "memory",
    description: "Display current memory files (both folder and global scopes)",
    argumentHint: "[scope] - 'folder', 'global', or 'both' (default)",
    content: `Display the contents of the memory files with analysis:

1. **Folder Memory** (AGENTS.md - project-specific)
   - Full contents of the file
   - Line count and byte size
   - Last modified date

2. **Global Memory** (GLOBAL_AGENTS.md - cross-project)
   - Full contents of the file
   - Line count and byte size
   - Last modified date

3. **Analysis**
   - What each scope contains
   - Whether memory is being effectively used
   - Recommendations for organization`,
  },
  "git-status": {
    name: "git-status",
    description: "Show git repository status and branch information",
    argumentHint: "[log-count] - number of recent commits to show (default: 5)",
    content: `Display git repository status including:

1. **Current Branch**
   - Branch name
   - Tracking branch (if set)

2. **Changes**
   - Staged files (ready to commit)
   - Unstaged changes (modified files)
   - Untracked files

3. **Recent Commits**
   - Last 5 commits (or specified number)
   - Author and commit message
   - Time ago

4. **Repository Status**
   - Clean/dirty status
   - Ahead/behind upstream (if tracking)`,
  },
  analyze: {
    name: "analyze",
    description: "Analyze codebase structure and key components",
    argumentHint: "[path] - optional specific directory to analyze",
    content: `Provide a codebase analysis including:

1. **Project Structure**
   - Main directories and their purposes
   - Key entry points (src/extension.ts, src/agent.ts, etc.)
   - File organization overview

2. **Key Components**
   - Major modules and their responsibilities
   - Dependencies between components
   - File counts and line counts per module

3. **Statistics**
   - Total files and lines of code
   - Largest files
   - Test file overview

4. **Architecture Pattern**
   - Is it monolithic or modular?
   - Main data flow
   - Key abstractions`,
  },
  diagnostics: {
    name: "diagnostics",
    description: "Show workspace diagnostics (errors and warnings)",
    argumentHint: "[severity] - 'error', 'warning', or 'all' (default)",
    content: `Display TypeScript and workspace diagnostics:

1. **Errors** (prevent compilation)
   - File path and line number
   - Error message
   - Brief context

2. **Warnings** (potential issues)
   - File path and line number
   - Warning message
   - Suggested fix if available

3. **Summary**
   - Total errors and warnings
   - Files with issues
   - Severity breakdown

4. **Recommendations**
   - High-priority issues to fix
   - Common patterns in errors`,
  },
  review: {
    name: "review",
    description: "Code review checklist and guidelines for this project",
    argumentHint: "[file-path] - specific file to review",
    content: `Structured code review guidance including:

1. **Style Consistency**
   - Indentation rules (4-space in core files, tabs in src/tools/commands/)
   - Semicolon usage
   - Template literal restrictions (none in webview code)
   - Line length limits

2. **Type Safety**
   - TypeScript strict mode compliance
   - Proper error handling
   - No unsafe type assertions

3. **Testing**
   - Tests exist for new code
   - Existing tests still pass
   - Edge cases covered

4. **Architecture**
   - Follows existing patterns
   - Path operations use resolveInWorkspace
   - Destructive operations guarded with confirmations

5. **Documentation**
   - Complex functions documented
   - Non-obvious behavior explained
   - Public APIs have comments

6. **Performance**
   - Large outputs truncated via truncateToolOutput
   - Read-only tools used concurrently`,
  },
  workspace: {
    name: "workspace",
    description: "Show workspace structure and organization",
    argumentHint: "[depth] - directory tree depth to show (default: 3)",
    content: `Display workspace structure and information:

1. **Workspace Root**
   - Root path
   - Type (is it a git repo?)

2. **Directory Structure**
   - Tree view with common directories highlighted
   - Purpose of each major directory
   - File count per directory

3. **Key Files**
   - package.json (name, version, key scripts)
   - tsconfig.json (compiler settings)
   - .gitignore (what's ignored)
   - Configuration files

4. **Statistics**
   - Total files
   - Source files vs tests vs docs
   - Approximate total lines of code

5. **Organization**
   - Is structure clear and logical?
   - Are naming conventions consistent?
   - Any unusual or non-standard patterns?`,
  },
}

/**
 * Get all built-in commands as Command objects
 */
export async function getBuiltInCommands(): Promise<Command[]> {
  return Object.values(BUILT_IN_COMMANDS).map((cmd) => ({
    name: cmd.name,
    content: cmd.content,
    source: "built-in" as const,
    filePath: `<built-in:${cmd.name}>`,
    description: cmd.description,
    argumentHint: cmd.argumentHint,
  }))
}

/**
 * Get a specific built-in command by name
 */
export async function getBuiltInCommand(name: string): Promise<Command | undefined> {
  const cmd = BUILT_IN_COMMANDS[name]
  if (!cmd) return undefined

  return {
    name: cmd.name,
    content: cmd.content,
    source: "built-in" as const,
    filePath: `<built-in:${name}>`,
    description: cmd.description,
    argumentHint: cmd.argumentHint,
  }
}

/**
 * Get names of all built-in commands
 */
export async function getBuiltInCommandNames(): Promise<string[]> {
  return Object.keys(BUILT_IN_COMMANDS)
}

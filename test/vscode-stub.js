// Minimal stub of the "vscode" module so agent.ts's pure/exported helpers
// can be unit tested with plain Node (no VS Code extension host required).
// Only functions actually exercised by unit tests need real behavior; the
// rest exist so `require("vscode")` and module-scope references don't throw.
const fs = require("fs");
const path = require("path");

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}

class Selection extends Range {}

// Converts a simple glob ('**', '*', literal segments) into a RegExp.
function globToRegExp(glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex specials (not * or /)
    .replace(/\*\*\//g, "(?:.*/)?")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  return new RegExp("^" + re + "$");
}

// Real (simplified) recursive glob over a directory tree, used by find_files
// and search_in_files tests so they exercise actual file discovery.
function realFindFiles(rootDir, glob, exclude) {
  if (!rootDir || !fs.existsSync(rootDir)) {
    return [];
  }
  const includeRe = globToRegExp(glob || "**/*");
  const excludeRe = exclude ? globToRegExp(exclude) : null;
  const results = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(rootDir, abs).split(path.sep).join("/");
      if (excludeRe && excludeRe.test(rel)) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(abs);
      } else if (includeRe.test(rel)) {
        results.push({ fsPath: abs });
      }
    }
  };
  walk(rootDir);
  return results;
}

const stub = {
  Position,
  Range,
  Selection,
  Uri: {
    file: (p) => ({ fsPath: p }),
  },
  // Tests set this before calling a tool that shows a confirmation dialog
  // (e.g. vscode.__confirm = "Delete"); defaults to "cancelled".
  __confirm: undefined,
  // Tests set this to control vscode.commands.executeCommand's return value,
  // e.g. vscode.__executeCommandImpl = (cmd, ...args) => [...symbols];
  __executeCommandImpl: undefined,
  // Tests push to this to observe run_in_terminal's sendText calls.
  __terminalSendTextCalls: [],
  // Tests set this Map<fsPath, Diagnostic[]> to control get_diagnostics.
  __diagnosticsMap: new Map(),
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  SymbolKind: {
    File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5, Property: 6,
    Field: 7, Constructor: 8, Enum: 9, Interface: 10, Function: 11, Variable: 12,
    Constant: 13, String: 14, Number: 15, Boolean: 16, Array: 17, Object: 18, Key: 19,
    Null: 20, EnumMember: 21, Struct: 22, Event: 23, Operator: 24, TypeParameter: 25,
  },
  window: {
    createOutputChannel: () => ({ appendLine: () => {}, show: () => {} }),
    showWarningMessage: async (..._args) => stub.__confirm,
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
    showTextDocument: async () => ({}),
    showErrorMessage: () => {},
    // Tests set this to a fake editor object to control get_active_editor.
    activeTextEditor: undefined,
    createTerminal: (_name) => ({
      show: () => {},
      sendText: (cmd) => stub.__terminalSendTextCalls.push(cmd),
    }),
  },
  workspace: {
    // Tests set this to [{ uri: { fsPath: tmpDir } }] to point tools at a
    // real temp directory on disk.
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: (_key, def) => def }),
    findFiles: async (glob, exclude) => {
      const folders = stub.workspace.workspaceFolders;
      const root = folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
      return realFindFiles(root, glob, exclude);
    },
    openTextDocument: async (fsPath) => ({
      uri: typeof fsPath === "string" ? { fsPath } : fsPath,
    }),
  },
  languages: {
    getDiagnostics: (uri) => {
      if (uri) {
        return stub.__diagnosticsMap.get(uri.fsPath) || [];
      }
      return Array.from(stub.__diagnosticsMap.entries()).map(([fsPath, diags]) => [{ fsPath }, diags]);
    },
  },
  commands: {
    registerCommand: () => ({ dispose: () => {} }),
    executeCommand: async (cmd, ...args) => {
      if (typeof stub.__executeCommandImpl === "function") {
        return stub.__executeCommandImpl(cmd, ...args);
      }
      return undefined;
    },
  },
};

module.exports = stub;


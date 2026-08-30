#!/usr/bin/env node
/**
 * Clean build for ai-agent-chat.
 * Usage:
 *   node build.js                full clean build
 *   node build.js --skip-install skip npm ci (reuse node_modules)
 *   node build.js --install      also install the vsix into VS Code
 *   node build.js --help         show help
 */

"use strict";

const child = require("child_process");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const ROOT = __dirname;

function log(msg) {
  console.log("\n==> " + msg);
}

function fail(msg) {
  console.error("\nBUILD FAILED: " + msg);
  process.exit(1);
}

function run(cmd, argv, opts) {
  console.log("    > " + cmd + " " + argv.join(" "));
  const r = child.spawnSync(cmd, argv, Object.assign({ stdio: "inherit", cwd: ROOT, shell: process.platform === "win32" }, opts || {}));
  if (r.status !== 0) {
    fail(cmd + " exited with code " + r.status);
  }
}

function showHelp() {
  console.log(
    "\n" +
    "ai-agent-chat build script\n" +
    "\n" +
    "USAGE\n" +
    "    node build.js [options]\n" +
    "\n" +
    "OPTIONS\n" +
    "    --skip-install   Skip the dependency install step (reuse node_modules).\n" +
    "    --install        Install the packaged vsix into VS Code when done.\n" +
    "    --help, -h       Show this help and exit.\n" +
    "\n" +
    "EXAMPLES\n" +
    "    node build.js                    full clean build\n" +
    "    node build.js --skip-install     fast rebuild, no dependency install\n" +
    "    node build.js --install          build, package, install into VS Code\n" +
    "\n" +
    "NOTES\n" +
    "    - Cleans out/ and previous .vsix files (keeps node_modules).\n" +
    "    - Uses npm ci for a reproducible install from package-lock.json.\n" +
    "    - Verifies that out/extension.js and the .vsix really exist after\n" +
    "      each step, so silent tool failures are caught.\n"
  );
}

// ---- parse args ------------------------------------------------------------

if (args.includes("--help") || args.includes("-h")) {
  showHelp();
  process.exit(0);
}
const skipInstall = args.includes("--skip-install");
const installVsix = args.includes("--install");

// ---- 0. preflight ----------------------------------------------------------

log("Checking tools");
["node", "npm", "npx"].forEach(function (tool) {
  const found = child.spawnSync(tool, ["--version"], { shell: true });
  if (found.error || found.status !== 0) {
    fail(tool + " not found in PATH");
  }
});
console.log("    node " + child.execSync("node -v").toString().trim() + ", npm " + child.execSync("npm -v").toString().trim());

// ---- 1. clean --------------------------------------------------------------

log("Cleaning previous build artifacts");
removeDir(path.join(ROOT, "out"));
fs.readdirSync(ROOT).forEach(function (f) {
  if (f.endsWith(".vsix")) {
    fs.unlinkSync(path.join(ROOT, f));
    console.log("    removed " + f);
  }
});

function removeDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log("    removed " + path.relative(ROOT, dir) + "/");
  }
}

// ---- 2. install ------------------------------------------------------------

if (skipInstall) {
  log("Skipping dependency install (--skip-install)");
} else {
  log("Installing dependencies (npm ci)");
  run("npm", ["ci", "--no-audit", "--no-fund"]);
}

// ---- 3. compile ------------------------------------------------------------

log("Compiling TypeScript");
run("npm", ["run", "compile"]);

if (!fs.existsSync(path.join(ROOT, "out", "extension.js"))) {
  fail("out/extension.js was not produced");
}

// ---- 4. package ------------------------------------------------------------

log("Packaging vsix");
run("npx", ["--yes", "@vscode/vsce", "package", "--allow-missing-repository"]);

const vsixFiles = fs.readdirSync(ROOT).filter(function (f) { return f.endsWith(".vsix"); });
if (vsixFiles.length === 0) {
  fail("no .vsix produced - packaging silently failed");
}

vsixFiles.forEach(function (f) {
  const kb = Math.round(fs.statSync(path.join(ROOT, f)).size / 1024 * 10) / 10;
  console.log("\nPackaged: " + f + " (" + kb + " KB)");
});

// ---- 5. optional install ---------------------------------------------------

if (installVsix) {
  log("Installing into VS Code");
  run("code", ["--install-extension", vsixFiles[0]]);
  console.log("Installed. Reload the VS Code window to activate.");
}

console.log("\nBuild OK.");

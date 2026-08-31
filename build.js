#!/usr/bin/env node
/**
 * Clean build for ai-agent-chat.
 * Usage:
 *   node build.js                full clean build (also installs vsix into VS Code)
 *   node build.js --skip-install skip npm ci (reuse node_modules)
 *   node build.js --no-install   build + package, but skip installing the vsix
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
    "    --skip-deps      Skip the dependency install step (reuse node_modules).\n" +
    "    --install        (default) Install the packaged vsix into VS Code when done. Kept for compatibility.\n" +
    "    --no-install     Build and package, but skip installing the vsix into VS Code.\n" +        
    "    --help, -h       Show this help and exit.\n" +
    "\n" +
    "EXAMPLES\n" +
    "    node build.js                    full clean build\n" +
    "    node build.js --skip-deps        fast rebuild, no dependency install\n" +
    "    node build.js --install          build, package, install into VS Code\n" +
    "    node build.js --no-install       build, package, but skip installing the vsix into VS Code\n" +  
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
const skipDeps = args.includes("--skip-deps");
// Install the packaged vsix into VS Code by default. Use --no-install to skip it.
const installVsix = !args.includes("--no-install");

// ---- 0. preflight ----------------------------------------------------------

log("Checking tools");
["node", "npm", "npx"].forEach(function (tool) {
  const found = child.spawnSync(tool, ["--version"], { shell: true });
  if (found.error || found.status !== 0) {
    fail(tool + " not found in PATH");
  }
});
console.log("    node " + child.execSync("node -v").toString().trim() + ", npm " + child.execSync("npm -v").toString().trim());

// ---- 0.5 sync readme version -----------------------------------------------

log("Syncing version to README.md");
const pkgPath = path.join(ROOT, "package.json");
const readmePath = path.join(ROOT, "README.md");

if (fs.existsSync(pkgPath) && fs.existsSync(readmePath)) {
  const pkg = require(pkgPath);
  const version = pkg.version;
  const readmeContent = fs.readFileSync(readmePath, "utf8");
  
  const updatedReadme = readmeContent.replace(
    /!\[Version\]\(https:\/\/img\.shields\.io\/badge\/version-[0-9A-Za-z.-]+-blue\)/g,
    "![Version](https://img.shields.io/badge/version-" + version + "-blue)"
  );
  
  if (readmeContent !== updatedReadme) {
    fs.writeFileSync(readmePath, updatedReadme, "utf8");
    console.log("    Updated README.md to version " + version);
  } else {
    console.log("    README.md already up to date (" + version + ")");
  }
} else {
  console.log("    Skipped: package.json or README.md not found");
}

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

if (skipDeps) {
  log("Skipping dependency install (--skip-deps)");
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
run("npx", ["--yes", "@vscode/vsce", "package", "--allow-missing-repository", "--no-dependencies"], {
    env: {
        VSCE_DISABLE_TELEMETRY: "1",
        NODE_OPTIONS: "--no-deprecation"
    }
});
log("Packaging vsix done");

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

// bundle.js - creates project-bundle.md, split into parts under ~80K each
// Run from the project root: node bundle.js
var fs = require("fs");
var path = require("path");

var ROOT = process.cwd();
var SOFT_LIMIT = 85000;  // start a new part once we pass this (buffer under 80K)

var FILES = [
  "package.json",
  "tsconfig.json",
  "README.md",
  "src/extension.ts",
  "src/chatPanel.ts",
  "src/agent.ts",
  "src/apiClient.ts",
  "media/chat-icon-dark.svg",
  "media/chat-icon-light.svg",
  ".vscodeignore",
  ".gitignore",
  ".npmrc",
  "LICENSE",
  "build.js",
  "build.ps1"
];

var parts = [];   // array of strings
var current = "";
var ok = 0;
var miss = 0;
var partIndex = 1;

function header() {
  return "PROJECT BUNDLE: ai-agent-chat (VS Code extension) - PART " + partIndex +
    "\nGenerated: " + new Date().toISOString() + "\n\n";
}

function startPart() {
  current = header();
  partIndex = partIndex + 1;
}

function endPart() {
  parts.push(current);
}

startPart();

for (var i = 0; i < FILES.length; i++) {
  var rel = FILES[i];
  var full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) {
    console.log("MISS   " + rel);
    miss = miss + 1;
    continue;
  }
  var content = fs.readFileSync(full, "utf8");
  var lang = "text";
  if (rel.slice(-3) === ".ts") { lang = "typescript"; }
  else if (rel.slice(-5) === ".json") { lang = "json"; }
  else if (rel.slice(-4) === ".md") { lang = "markdown"; }

  var fence = "==================================================\n" +
              "FILE: " + rel + "\n" +
              "==================================================\n" +
              "```" + lang + "\n";

  // If this file won't fit in the current part, close it and start a new one
  if (current.length + fence.length > SOFT_LIMIT && current.length > header().length) {
    endPart();
    startPart();
  }

  // File fits whole
  if (current.length + fence.length + content.length + 8 <= SOFT_LIMIT) {
    current += fence + content;
    if (content.slice(-1) !== "\n") { current += "\n"; }
    current += "```\n\n";
    ok = ok + 1;
    console.log("ADDED  " + rel + " (" + content.length + " chars)");
    continue;
  }

  // File too big to fit whole -> split it at line boundaries across parts
  console.log("SPLIT  " + rel + " (" + content.length + " chars) - exceeds part limit");
  var lines = content.split("\n");
  var inFence = false;
  for (var l = 0; l < lines.length; l++) {
    var line = lines[l] + "\n";
    if (current.length + line.length > SOFT_LIMIT && current.length > header().length) {
      if (inFence) { current += "```\n\n"; }
      endPart();
      startPart();
      current += fence;
      inFence = true;
    }
    if (!inFence) { current += fence; inFence = true; }
 current += line;
  }
  if (inFence) { current += "```\n\n"; }
  ok = ok + 1;
}
endPart();

// Write outputs (single file if only one part)
var written = [];
for (var p = 0; p < parts.length; p++) {
  var name = parts.length === 1
    ? "project-bundle.md"
    : "project-bundle.part" + (p + 1) + ".md";
  fs.writeFileSync(path.join(ROOT, name), parts[p], "utf8");
  console.log("Wrote " + name + " (" + parts[p].length + " chars)");
  written.push(name);
}

console.log("--------------------------------------------------");
console.log("Parts: " + parts.length + " | files: " + ok + " | missing: " + miss);

// Clean up stale part files from previous runs (e.g. old part3 when now only 2 parts)
var n = parts.length + 1;
while (true) {
  var stale = path.join(ROOT, "project-bundle.part" + n + ".md");
  if (fs.existsSync(stale)) {
    fs.unlinkSync(stale);
    console.log("Removed stale " + "project-bundle.part" + n + ".md");
    n = n + 1;
  } else { break; }
}

// bundle.js - creates project-bundle.md, split into parts under ~80K each
// Run from the project root: node bundle.js
var fs = require("fs");
var path = require("path");

var ROOT = process.cwd();
var SOFT_LIMIT = 40000;  // start a new part once we pass this (buffer under 80K)

// Top-level files bundled in a fixed, deliberate order.
var TOP_LEVEL_FILES = [
  "package.json",
  "tsconfig.json",
  "README.md"
];

// Everything under src/ is discovered automatically (recursive), so adding a
// new source file no longer requires editing this list.
var SCAN_ROOT = "src";
var SKIP_DIRS = ["test"];     // skip src/test (and any nested dir named test)
var SKIP_SUFFIXES = [".bak"]; // skip backups like src/apiClient.ts.bak

function scanDir(dir) {
  var found = [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.indexOf(e.name) !== -1) { return; }
      found = found.concat(scanDir(path.join(dir, e.name)));
    } else if (e.isFile()) {
      if (SKIP_SUFFIXES.some(function (s) { return e.name.slice(-s.length) === s; })) { return; }
      // Normalise to forward slashes so paths match on Windows and Unix.
      found.push(path.relative(ROOT, path.join(dir, e.name)).replace(/\\/g, "/"));
    }
  });
  return found;
}

var srcFiles = scanDir(path.join(ROOT, SCAN_ROOT)).sort();
console.log("Scanned " + SCAN_ROOT + "/ -> " + srcFiles.length + " file(s): " + srcFiles.join(", "));
var FILES = TOP_LEVEL_FILES.concat(srcFiles);

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

// bundle-files.js - bundle the files given as command-line arguments into
// file-bundle.md. Each file is capped at FILE_LIMIT (40K) chars; when it would
// exceed the limit it is truncated and a notice is appended. When the running
// total of a part would exceed PART_LIMIT (40K) chars, the bundle is split into
// file-bundle.part1.md, file-bundle.part2.md, ...
//
// Usage:
//   node bundle-files.js <file> [<file> ...]
//
// Examples:
//   node bundle-files.js src/agent.ts src/tools.ts
//   node bundle-files.js package.json tsconfig.json README.md
//
// Paths are resolved relative to the current working directory and normalised
// to forward slashes so the output is identical on Windows and Unix. Missing
// files are reported and skipped (the bundle still builds from the rest).
var fs = require("fs");
var path = require("path");

var FILE_LIMIT = 40000;  // per-file char cap (truncate + notice when exceeded)
var PART_LIMIT = 40000;  // per-part char cap (start a new part when exceeded)

var FILES = process.argv.slice(2);
var ROOT = process.cwd();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Pick a fenced-code-block language from the file extension.
function langFor(rel) {
  var ext = path.extname(rel).toLowerCase();
  switch (ext) {
    case ".ts": return "typescript";
    case ".js": return "javascript";
    case ".json": return "json";
    case ".md": return "markdown";
    case ".html": return "html";
    case ".css": return "css";
    default: return "text";
  }
}

// Build the separator/fence header for one file section.
function fenceFor(rel, lang, opts) {
  var head = "==================================================\n" +
             "FILE: " + rel + "\n";
  if (opts && opts.part) {
    head += "(part " + opts.part + ")\n";
  }
  head += "==================================================\n" +
          "```" + lang + "\n";
  return head;
}

function headerFor(index) {
  return "FILE BUNDLE - PART " + index + "\n" +
         "Generated: " + new Date().toISOString() + "\n\n";
}

// Truncate a file's content to FILE_LIMIT and append a clear notice pointing
// the reader at the rest of the file (kept here to match the codebase's
// context-preservation conventions).
function capFile(content, rel) {
  if (content.length <= FILE_LIMIT) {
    return content;
  }
  var notice = "\n\n... [File '" + rel + "' truncated at " + FILE_LIMIT +
               " chars (" + content.length + " total). See the original file for the remaining " +
               (content.length - FILE_LIMIT) + " chars.]";
  return content.slice(0, FILE_LIMIT) + notice;
}

// ---------------------------------------------------------------------------
// Collect + bundle
// ---------------------------------------------------------------------------
if (FILES.length === 0) {
  console.error("Usage: node bundle-files.js <file> [<file> ...]");
  process.exit(1);
}

var parts = [];      // array of accumulated part strings
var current = "";    // in-progress part
var partIndex = 1;
var ok = 0;
var miss = 0;

function startPart() {
  current = headerFor(partIndex);
  partIndex = partIndex + 1;
}

function endPart() {
  parts.push(current);
}

startPart();

for (var i = 0; i < FILES.length; i++) {
  var rel = FILES[i].replace(/\\/g, "/");
  var full = path.resolve(ROOT, rel);

  if (!fs.existsSync(full)) {
    console.log("MISS   " + rel);
    miss = miss + 1;
    continue;
  }

  var content = fs.readFileSync(full, "utf8");
  var lang = langFor(rel);
  var capped = capFile(content, rel);
  var fence = fenceFor(rel, lang);
  var closing = "\n```\n\n";
  var block = fence + capped + (capped.slice(-1) !== "\n" ? "\n" : "") + closing;

  // If adding this block would blow the part limit, close the current part and
  // start a new one (but only if the current part already holds real content
  // beyond its header, so the first file never sits in an empty overflow part).
  if (current.length + block.length > PART_LIMIT && current.length > headerFor(1).length) {
    endPart();
    startPart();
  }

  current += block;
  ok = ok + 1;
  console.log("ADDED  " + rel + " (" + content.length + " chars" +
              (content.length > FILE_LIMIT ? ", capped to " + FILE_LIMIT : "") + ")");
}
endPart();

// ---------------------------------------------------------------------------
// Write outputs
// ---------------------------------------------------------------------------
for (var p = 0; p < parts.length; p++) {
  var name = parts.length === 1
    ? "file-bundle.md"
    : "file-bundle.part" + (p + 1) + ".md";
  fs.writeFileSync(path.join(ROOT, name), parts[p], "utf8");
  console.log("Wrote " + name + " (" + parts[p].length + " chars)");
}

console.log("--------------------------------------------------");
console.log("Parts: " + parts.length + " | files: " + ok + " | missing: " + miss);

// Clean up stale part files from a previous run.
// - When this run produced a SINGLE bundle (file-bundle.md, no parts), remove
//   every leftover file-bundle.partN.md from a prior multi-part run (starting
//   at part1, since a single-part run never writes part1).
// - When this run produced MULTIPLE parts, only parts beyond parts.length can
//   be stale, so start scanning at parts.length + 1.
var n = (parts.length === 1) ? 1 : (parts.length + 1);
while (true) {
  var stale = path.join(ROOT, "file-bundle.part" + n + ".md");
  if (fs.existsSync(stale)) {
    fs.unlinkSync(stale);
    console.log("Removed stale file-bundle.part" + n + ".md");
    n = n + 1;
  } else {
    break;
  }
}

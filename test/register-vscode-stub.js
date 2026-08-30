// Redirects require("vscode") to test/vscode-stub.js so agent.ts can be
// required by plain Node during unit tests, outside the extension host.
const Module = require("module");
const path = require("path");

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") {
    return path.join(__dirname, "vscode-stub.js");
  }
  return originalResolve.call(this, request, ...rest);
};

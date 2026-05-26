#!/usr/bin/env node
// Warn-only grep heuristics over a plugin source tree.
//
// The hard security boundary is Mallard's permission system + Lua sandbox.
// This scan is purely advisory — it flags surprising patterns for the curator
// to eyeball during PR review. It NEVER fails the build.
//
// Output: JSON Lines on stdout, one finding per line.
//
// Usage:
//   node scripts/scan-source.mjs --source-dir <path> [--language lua|ts]

import { readFile, readdir, stat } from "node:fs/promises";
import { join, extname, relative, resolve } from "node:path";

const LUA_PATTERNS = [
  ["os.execute",        /\bos\.execute\s*\(/,         "shell escape"],
  ["io.popen",          /\bio\.popen\s*\(/,           "shell escape"],
  ["loadstring",        /\bloadstring\s*\(/,          "dynamic code"],
  ["load_dynamic",      /\bload\s*\(/,                "dynamic code (load())"],
  ["dofile",            /\bdofile\s*\(/,              "file read + execute"],
  ["require_os",        /\brequire\s*\(\s*["']os["']\s*\)/, "sandbox escape attempt"],
  ["require_io",        /\brequire\s*\(\s*["']io["']\s*\)/, "sandbox escape attempt"],
];

const TS_PATTERNS = [
  ["eval",              /\beval\s*\(/,                "dynamic code"],
  ["Function_ctor",     /\bnew\s+Function\s*\(/,      "dynamic code"],
  ["child_process",     /child_process|require\s*\(\s*["']child_process["']\s*\)/, "subprocess"],
  ["fs_write",          /\bfs(?:Promises)?\.write(File)?Sync?\s*\(/, "filesystem write"],
  ["fs_unlink",         /\bfs(?:Promises)?\.unlink(Sync)?\s*\(/, "filesystem delete"],
  ["process_exit",      /\bprocess\.exit\s*\(/,       "process termination"],
];

const COMMON_PATTERNS = [
  ["non_https_fetch",   /(?:fetch|axios|http\.get|http\.post)\s*\(\s*["'](?:http:\/\/|file:\/\/)/, "non-HTTPS or file:// URL"],
];

const LUA_EXT = new Set([".lua"]);
const TS_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walk(p)));
    } else if (e.isFile()) {
      out.push(p);
    }
  }
  return out;
}

function findingsForFile(rel, content, patterns) {
  const findings = [];
  const lines = content.split("\n");
  for (const [id, re, category] of patterns) {
    for (let i = 0; i < lines.length; i += 1) {
      if (re.test(lines[i])) {
        findings.push({
          file: rel,
          line: i + 1,
          pattern: id,
          category,
          severity: "warn",
          excerpt: lines[i].trim().slice(0, 200),
        });
      }
    }
  }
  return findings;
}

async function main() {
  const args = new Map();
  for (let i = 0; i < process.argv.length - 1; i += 1) {
    if (process.argv[i].startsWith("--")) {
      args.set(process.argv[i].slice(2), process.argv[i + 1]);
    }
  }
  const sourceDir = args.get("source-dir");
  if (!sourceDir) {
    console.error("scan-source: --source-dir <path> required");
    process.exit(2);
  }
  const language = (args.get("language") || "").toLowerCase();
  const root = resolve(sourceDir);

  let sawAny = false;
  for (const f of await walk(root)) {
    const ext = extname(f).toLowerCase();
    let patterns = [...COMMON_PATTERNS];
    if (LUA_EXT.has(ext) && (language === "lua" || language === "")) patterns = [...patterns, ...LUA_PATTERNS];
    if (TS_EXT.has(ext) && (language === "ts" || language === "")) patterns = [...patterns, ...TS_PATTERNS];
    if (patterns === COMMON_PATTERNS && ext !== "") continue;
    let content;
    try {
      content = await readFile(f, "utf8");
    } catch {
      continue;
    }
    const findings = findingsForFile(relative(root, f), content, patterns);
    for (const finding of findings) {
      sawAny = true;
      console.log(JSON.stringify(finding));
    }
  }

  if (!sawAny) {
    console.error("scan-source: no findings.");
  }
}

main().catch((e) => {
  console.error("scan-source failed:", e);
  process.exit(2);
});

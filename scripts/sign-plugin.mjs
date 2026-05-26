#!/usr/bin/env node
// Produce a detached minisign signature for a built `.mallardx`.
//
// Usage:
//   echo "<passphrase>" | node scripts/sign-plugin.mjs --archive <path> --key <path>
//
// The test key shipped under tests/fixtures/test_minisign.key uses an empty
// passphrase — echo "" suffices. The production key (provisioned only as a
// GitHub Actions secret) has a real passphrase from MARKETPLACE_SIGNING_PASSPHRASE.

import { existsSync, statSync } from "node:fs";
import { spawnSync, execSync } from "node:child_process";
import { resolve } from "node:path";

function parseArgs() {
  const args = new Map();
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].startsWith("--")) {
      args.set(a[i].slice(2), a[i + 1]);
      i += 1;
    }
  }
  return args;
}

function readAllStdin() {
  const chunks = [];
  let buf;
  try {
    // node's blocking stdin read
    buf = require("node:fs").readFileSync(0, "utf8");
    return buf;
  } catch {
    return "";
  }
}

async function main() {
  const args = parseArgs();
  const archive = args.get("archive");
  const key = args.get("key");
  if (!archive || !key) {
    console.error("usage: sign-plugin.mjs --archive <path> --key <path>");
    process.exit(2);
  }
  const archivePath = resolve(archive);
  const keyPath = resolve(key);
  if (!existsSync(archivePath)) {
    console.error(`sign-plugin: archive not found: ${archivePath}`);
    process.exit(2);
  }
  if (!existsSync(keyPath)) {
    console.error(`sign-plugin: key not found: ${keyPath}`);
    process.exit(2);
  }

  // Ensure minisign is on PATH
  try {
    execSync("which minisign", { stdio: "ignore" });
  } catch {
    console.error("sign-plugin: minisign not found on PATH. Install: brew install minisign (macOS) / apt-get install minisign (Linux)");
    process.exit(2);
  }

  // Read passphrase from stdin (single line)
  let passphrase = "";
  if (!process.stdin.isTTY) {
    passphrase = (await readPassFromStdin()).replace(/\r?\n.*/s, "");
  }

  // Invoke minisign. The `-W` flag is NOT used — we always use passphrase-protected keys.
  // minisign reads the passphrase from stdin when -t is given via env var.
  // The reliable approach: write passphrase to a temp file? No — pass via stdin to minisign.
  // minisign's CLI prompts twice (passphrase, then verify). Pipe passphrase\n\n.
  const stdinInput = `${passphrase}\n`;
  const res = spawnSync(
    "minisign",
    ["-S", "-s", keyPath, "-m", archivePath],
    {
      input: stdinInput,
      stdio: ["pipe", "inherit", "inherit"],
    },
  );
  if (res.status !== 0) {
    console.error(`sign-plugin: minisign exited with status ${res.status}`);
    process.exit(1);
  }

  const sigPath = `${archivePath}.minisig`;
  if (!existsSync(sigPath) || statSync(sigPath).size === 0) {
    console.error(`sign-plugin: signature not produced or empty: ${sigPath}`);
    process.exit(1);
  }
  console.log(sigPath);
}

function readPassFromStdin() {
  return new Promise((resolveP) => {
    let acc = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      acc += chunk;
    });
    process.stdin.on("end", () => resolveP(acc));
    process.stdin.on("error", () => resolveP(acc));
  });
}

main().catch((e) => {
  console.error("sign-plugin failed:", e);
  process.exit(1);
});

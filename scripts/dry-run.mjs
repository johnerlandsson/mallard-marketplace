#!/usr/bin/env node
// Run the full pipeline locally with test keys. For each submission under
// plugins/, build the plugin, sign with the test key, then generate the
// catalog. Output lands in dist/ + public/. Existing dist/ and public/ are
// wiped at the start so re-runs are deterministic.
//
// Optional flags:
//   --id <id>                only run the named plugin
//   --version <version>      with --id, only that version
//   --local-source <path>    pass through to build-plugin (for ref="v0.1.0-dryrun" testing)
//
// Usage:
//   npm run dry-run

import { existsSync } from "node:fs";
import { rm, readdir, readFile } from "node:fs/promises";
import { execSync, spawnSync } from "node:child_process";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const PLUGINS_DIR = join(REPO_ROOT, "plugins");
const TEST_KEY = join(REPO_ROOT, "tests/fixtures/test_minisign.key");

function parseArgs() {
  const args = new Map();
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].startsWith("--")) {
      const next = a[i + 1];
      if (next && !next.startsWith("--")) {
        args.set(a[i].slice(2), next);
        i += 1;
      } else {
        args.set(a[i].slice(2), true);
      }
    }
  }
  return args;
}

async function listSubmissions(filterId, filterVersion) {
  const out = [];
  for (const id of await readdir(PLUGINS_DIR)) {
    if (filterId && id !== filterId) continue;
    const idDir = join(PLUGINS_DIR, id);
    for (const f of await readdir(idDir)) {
      if (!f.endsWith(".toml")) continue;
      const version = f.replace(/\.toml$/, "");
      if (filterVersion && version !== filterVersion) continue;
      out.push({ id, version });
    }
  }
  return out;
}

async function main() {
  const args = parseArgs();

  for (const dir of ["dist", "public"]) {
    const p = join(REPO_ROOT, dir);
    if (existsSync(p)) {
      console.log(`rm -rf ${dir}/`);
      await rm(p, { recursive: true, force: true });
    }
  }

  // Lint everything first.
  console.log("\n[1/4] lint-submission");
  execSync("node scripts/lint-submission.mjs", { cwd: REPO_ROOT, stdio: "inherit" });

  // Build each.
  const submissions = await listSubmissions(args.get("id"), args.get("version"));
  if (submissions.length === 0) {
    console.error("dry-run: no submissions matched.");
    process.exit(1);
  }
  console.log(`\n[2/4] build-plugin (${submissions.length} submission${submissions.length === 1 ? "" : "s"})`);
  for (const { id, version } of submissions) {
    const buildArgs = ["scripts/build-plugin.mjs", "--id", id, "--version", version];
    if (args.get("local-source") && args.get("local-source") !== true) {
      buildArgs.push("--local-source", args.get("local-source"));
    }
    const res = spawnSync("node", buildArgs, { cwd: REPO_ROOT, stdio: "inherit" });
    if (res.status !== 0) {
      console.error(`dry-run: build-plugin ${id}@${version} failed`);
      process.exit(res.status || 1);
    }
  }

  // Sign each with the test key.
  console.log(`\n[3/4] sign-plugin (test key; empty passphrase)`);
  for (const { id, version } of submissions) {
    const receipt = JSON.parse(await readFile(join(REPO_ROOT, "dist", id, version, "build-receipt.json"), "utf8"));
    const archive = join(REPO_ROOT, "dist", id, version, receipt.artifact);
    const res = spawnSync(
      "node",
      ["scripts/sign-plugin.mjs", "--archive", archive, "--key", TEST_KEY],
      { cwd: REPO_ROOT, stdio: ["pipe", "inherit", "inherit"], input: "\n" },
    );
    if (res.status !== 0) {
      console.error(`dry-run: sign-plugin ${id}@${version} failed`);
      process.exit(res.status || 1);
    }
  }

  // Generate index.
  console.log(`\n[4/4] build-index`);
  execSync("node scripts/build-index.mjs --base-url http://localhost:8080", { cwd: REPO_ROOT, stdio: "inherit" });

  console.log(`\n✓ dry-run OK.`);
  console.log(`  Serve locally: python3 -m http.server 8080 -d public`);
  console.log(`  Then: curl http://localhost:8080/index.json | jq .`);
}

main().catch((e) => {
  console.error("dry-run failed:", e);
  process.exit(1);
});

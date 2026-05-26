#!/usr/bin/env node
// Validate plugins/<id>/<version>.toml submission files against the schema.
//
// Usage:
//   node scripts/lint-submission.mjs                                # all submissions under plugins/
//   node scripts/lint-submission.mjs plugins/foo/1.0.0.toml         # single file
//   node scripts/lint-submission.mjs --changed                      # only files changed vs. origin/main

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, join, relative } from "node:path";
import toml from "@iarna/toml";
import semver from "semver";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const PLUGINS_DIR = join(REPO_ROOT, "plugins");

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const REPO_SLUG_RE = /^[\w.-]+\/[\w.-]+$/;
const TAG_REF_RE = /^v?\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/;
const TAG_LOOKS_LIKE_BRANCH = /^(main|master|develop|HEAD)$/i;

let errors = 0;
let warnings = 0;

function err(file, msg) {
  console.error(`error: ${file}: ${msg}`);
  errors += 1;
}
function warn(file, msg) {
  console.warn(`warning: ${file}: ${msg}`);
  warnings += 1;
}

async function lintFile(absPath) {
  const rel = relative(REPO_ROOT, absPath);

  const match = rel.match(/^plugins\/([^/]+)\/([^/]+)\.toml$/);
  if (!match) {
    err(rel, `path must be plugins/<id>/<version>.toml`);
    return;
  }
  const [, idFromPath, versionFromPath] = match;

  if (!PLUGIN_ID_RE.test(idFromPath)) {
    err(rel, `plugin id "${idFromPath}" must be lowercase alphanumeric with . _ - separators`);
  }
  if (!semver.valid(versionFromPath)) {
    err(rel, `version "${versionFromPath}" is not valid semver`);
  }

  const raw = await readFile(absPath, "utf8");
  let parsed;
  try {
    parsed = toml.parse(raw);
  } catch (e) {
    err(rel, `TOML parse failed: ${e.message}`);
    return;
  }

  // [source] required
  const source = parsed.source;
  if (!source || typeof source !== "object") {
    err(rel, `missing [source] section`);
    return;
  }
  if (!source.repo || typeof source.repo !== "string" || !REPO_SLUG_RE.test(source.repo)) {
    err(rel, `[source].repo must be "owner/name"`);
  }
  if (!source.ref || typeof source.ref !== "string") {
    err(rel, `[source].ref required`);
  } else if (TAG_LOOKS_LIKE_BRANCH.test(source.ref)) {
    err(rel, `[source].ref "${source.ref}" looks like a branch — use an immutable tag`);
  } else if (!TAG_REF_RE.test(source.ref)) {
    warn(rel, `[source].ref "${source.ref}" doesn't look like a semver tag — CI will still require it to be a tag, not a branch or commit`);
  }
  if (!source.build || typeof source.build !== "string") {
    err(rel, `[source].build required (shell command)`);
  }
  if (!source.artifact || typeof source.artifact !== "string") {
    err(rel, `[source].artifact required (filename of produced .mallardx, no slashes)`);
  } else {
    if (source.artifact.includes("/") || source.artifact.includes("\\")) {
      err(rel, `[source].artifact must be a basename only, no path separators`);
    }
    if (!source.artifact.endsWith(".mallardx")) {
      err(rel, `[source].artifact must end with .mallardx`);
    }
  }

  // [meta] optional
  if (parsed.meta !== undefined) {
    const meta = parsed.meta;
    if (typeof meta !== "object" || Array.isArray(meta)) {
      err(rel, `[meta] must be a table`);
    } else {
      if (meta.homepage !== undefined && typeof meta.homepage !== "string") {
        err(rel, `[meta].homepage must be a string URL`);
      }
      if (meta.homepage && !/^https?:\/\//.test(meta.homepage)) {
        warn(rel, `[meta].homepage should be an http(s) URL`);
      }
      if (meta.tags !== undefined) {
        if (!Array.isArray(meta.tags) || !meta.tags.every((t) => typeof t === "string")) {
          err(rel, `[meta].tags must be an array of strings`);
        } else {
          for (const t of meta.tags) {
            if (!/^[a-z0-9][a-z0-9-]*$/.test(t)) {
              warn(rel, `tag "${t}" should be lowercase + hyphen-safe`);
            }
          }
        }
      }
      if (meta.size_cap_override !== undefined) {
        if (!Number.isInteger(meta.size_cap_override) || meta.size_cap_override < 1 || meta.size_cap_override > 50_000_000) {
          err(rel, `[meta].size_cap_override must be an integer 1..50_000_000`);
        } else {
          warn(rel, `[meta].size_cap_override = ${meta.size_cap_override} requires curator approval — flag in PR review`);
        }
      }
    }
  }

  // Top-level optional fields
  if (parsed.withdrawn !== undefined) {
    if (typeof parsed.withdrawn !== "boolean") {
      err(rel, `withdrawn must be a boolean`);
    } else if (parsed.withdrawn === true) {
      if (!parsed.withdrawn_reason || typeof parsed.withdrawn_reason !== "string") {
        err(rel, `withdrawn = true requires withdrawn_reason (non-empty string)`);
      }
    }
  }
  if (parsed.withdrawn_reason !== undefined && parsed.withdrawn !== true) {
    warn(rel, `withdrawn_reason set without withdrawn = true — has no effect`);
  }
}

async function walkPlugins() {
  if (!existsSync(PLUGINS_DIR)) return [];
  const out = [];
  for (const id of await readdir(PLUGINS_DIR)) {
    const idPath = join(PLUGINS_DIR, id);
    for (const file of await readdir(idPath)) {
      if (file.endsWith(".toml")) {
        out.push(join(idPath, file));
      }
    }
  }
  return out;
}

function changedFiles() {
  const baseRef = process.env.GITHUB_BASE_REF
    ? `origin/${process.env.GITHUB_BASE_REF}`
    : "origin/main";
  const out = execSync(`git diff --name-only --diff-filter=AM ${baseRef}`, {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return out
    .split("\n")
    .filter((p) => p.startsWith("plugins/") && p.endsWith(".toml"))
    .map((p) => join(REPO_ROOT, p));
}

async function main() {
  const args = process.argv.slice(2);
  let files;
  if (args.includes("--changed")) {
    files = changedFiles();
    if (files.length === 0) {
      console.log("No submission files changed.");
      return;
    }
  } else if (args.length > 0) {
    files = args.map((a) => resolve(a));
  } else {
    files = await walkPlugins();
  }

  for (const f of files) {
    await lintFile(f);
  }

  console.log(`\nLinted ${files.length} file(s): ${errors} error(s), ${warnings} warning(s).`);
  if (errors > 0) process.exit(1);
}

main().catch((e) => {
  console.error("lint-submission failed:", e);
  process.exit(2);
});

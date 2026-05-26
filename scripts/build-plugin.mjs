#!/usr/bin/env node
// Build a single submission: clone the source repo at the declared tag,
// run the build command, validate the resulting archive against the
// submission's id/version + size + structural rules, and write a build
// receipt for the index generator.
//
// Usage:
//   node scripts/build-plugin.mjs --id <id> --version <version>
//
// Optional flags:
//   --local-source <path>   use this local directory instead of cloning (dry-run only)
//   --output-root <path>    write to this dir instead of ./dist/
//   --skip-scan             skip the source scan (default: run it, include findings in receipt)

import { readFile, mkdir, copyFile, rm, writeFile, stat } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, join, basename, dirname, relative } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import toml from "@iarna/toml";
import semver from "semver";
import extractZip from "extract-zip";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const PLUGINS_DIR = join(REPO_ROOT, "plugins");
const DEFAULT_SIZE_CAP = 10 * 1024 * 1024; // 10 MB

function parseArgs() {
  const args = new Map();
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].startsWith("--")) {
      const key = a[i].slice(2);
      const val = i + 1 < a.length && !a[i + 1].startsWith("--") ? a[i + 1] : "true";
      args.set(key, val);
      if (val !== "true") i += 1;
    }
  }
  return args;
}

function run(cmd, cwd, env = {}) {
  console.log(`+ ${cmd}  (in ${cwd})`);
  execSync(cmd, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function cloneAtRef(repo, ref, dest) {
  // Verify ref is a tag, not a branch. `git ls-remote --tags` against the
  // upstream surfaces all tags; we require the ref to appear there.
  const lsOut = execSync(`git ls-remote --tags https://github.com/${repo}.git`, {
    encoding: "utf8",
  });
  const tags = new Set(
    lsOut
      .split("\n")
      .map((line) => line.match(/refs\/tags\/(.+?)(?:\^\{\})?$/)?.[1])
      .filter(Boolean),
  );
  if (!tags.has(ref)) {
    throw new Error(
      `ref "${ref}" is not a tag on ${repo}. Available tags: ${[...tags].slice(0, 5).join(", ")}${tags.size > 5 ? "..." : ""}`,
    );
  }
  run(`git clone --depth 1 --branch ${ref} https://github.com/${repo}.git ${dest}`, REPO_ROOT);
  const commit = execSync(`git rev-parse HEAD`, { cwd: dest, encoding: "utf8" }).trim();
  return commit;
}

async function validateArchiveContents(archivePath, contentsDir, declaredId, declaredVersion, sizeCap) {
  const archiveSize = (await stat(archivePath)).size;
  if (archiveSize > sizeCap) {
    throw new Error(`archive size ${archiveSize} exceeds cap ${sizeCap}`);
  }

  await extractZip(archivePath, { dir: contentsDir });

  const manifestPath = join(contentsDir, "plugin.toml");
  if (!existsSync(manifestPath)) {
    throw new Error(`archive missing plugin.toml at root`);
  }
  const manifestRaw = await readFile(manifestPath, "utf8");
  const manifest = toml.parse(manifestRaw);

  if (manifest.id !== declaredId) {
    throw new Error(`archive plugin.toml id "${manifest.id}" does not match submission id "${declaredId}"`);
  }
  if (manifest.version !== declaredVersion) {
    throw new Error(`archive plugin.toml version "${manifest.version}" does not match submission version "${declaredVersion}"`);
  }

  // Forbidden files at any depth
  async function walk(dir) {
    const out = [];
    const entries = await import("node:fs/promises").then((m) => m.readdir(dir, { withFileTypes: true }));
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        out.push(p);
        out.push(...(await walk(p)));
      } else {
        out.push(p);
      }
    }
    return out;
  }
  const all = await walk(contentsDir);
  const forbiddenSubstrings = [".git", "node_modules"];
  const forbiddenExact = new Set([".gitignore"]);
  const forbiddenExts = new Set([".mallardx"]);
  for (const p of all) {
    const rel = relative(contentsDir, p);
    for (const sub of forbiddenSubstrings) {
      if (rel.split("/").includes(sub)) {
        throw new Error(`archive contains forbidden path: ${rel}`);
      }
    }
    if (forbiddenExact.has(basename(rel))) {
      throw new Error(`archive contains forbidden file: ${rel}`);
    }
    if (forbiddenExts.has(rel.match(/(\.[^./]+)$/)?.[1])) {
      throw new Error(`archive contains nested archive: ${rel}`);
    }
  }

  return { manifest, archiveSize };
}

async function runScan(sourceDir, language) {
  const scanScript = join(REPO_ROOT, "scripts/scan-source.mjs");
  try {
    const out = execSync(
      `node ${scanScript} --source-dir ${sourceDir} --language ${language || ""}`,
      { encoding: "utf8" },
    );
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (e) {
    console.warn("scan-source produced no findings or errored:", e.message);
    return [];
  }
}

async function main() {
  const args = parseArgs();
  const id = args.get("id");
  const version = args.get("version");
  if (!id || !version) {
    console.error("usage: build-plugin.mjs --id <id> --version <version> [--local-source <path>] [--output-root <path>] [--skip-scan]");
    process.exit(2);
  }
  if (!semver.valid(version)) {
    console.error(`build-plugin: version "${version}" is not valid semver`);
    process.exit(2);
  }

  const submissionPath = join(PLUGINS_DIR, id, `${version}.toml`);
  if (!existsSync(submissionPath)) {
    console.error(`build-plugin: submission not found: ${submissionPath}`);
    process.exit(2);
  }
  const submission = toml.parse(await readFile(submissionPath, "utf8"));
  const src = submission.source;
  const sizeCap = submission.meta?.size_cap_override ?? DEFAULT_SIZE_CAP;

  const outputRoot = args.get("output-root") || join(REPO_ROOT, "dist");
  const outDir = join(outputRoot, id, version);
  if (existsSync(outDir)) {
    await rm(outDir, { recursive: true, force: true });
  }
  await mkdir(outDir, { recursive: true });

  // Acquire source
  const sourceDir = join(outDir, "source");
  let sourceCommit = "(local)";
  if (args.get("local-source") && args.get("local-source") !== "true") {
    const localPath = resolve(args.get("local-source"));
    console.log(`build-plugin: using local source at ${localPath} (--local-source)`);
    // Copy the local source tree so we don't pollute the user's working dir.
    run(`cp -R ${localPath} ${sourceDir}`, REPO_ROOT);
    try {
      sourceCommit = execSync(`git rev-parse HEAD`, { cwd: sourceDir, encoding: "utf8" }).trim();
    } catch {
      // not a git repo or no HEAD — fine for local-source dry runs
    }
  } else {
    sourceCommit = await cloneAtRef(src.repo, src.ref, sourceDir);
  }

  // Build
  run(src.build, sourceDir);

  // Locate produced archive
  const archiveSrcPath = join(sourceDir, src.artifact);
  if (!existsSync(archiveSrcPath)) {
    throw new Error(`build did not produce expected artifact: ${src.artifact} (looked for ${archiveSrcPath})`);
  }

  // Validate archive contents
  const contentsDir = join(outDir, "contents");
  const { manifest, archiveSize } = await validateArchiveContents(
    archiveSrcPath,
    contentsDir,
    id,
    version,
    sizeCap,
  );

  // Copy archive + manifest into the per-version output dir
  const archiveDestName = src.artifact;
  const archiveDest = join(outDir, archiveDestName);
  await copyFile(archiveSrcPath, archiveDest);
  await copyFile(join(contentsDir, "plugin.toml"), join(outDir, "plugin.toml"));
  const archiveSha256 = await sha256File(archiveDest);

  // Optional source scan
  let scanFindings = [];
  if (!args.has("skip-scan")) {
    scanFindings = await runScan(sourceDir, manifest.language || "");
  }

  const receipt = {
    id,
    version,
    artifact: archiveDestName,
    archive_sha256: archiveSha256,
    archive_size: archiveSize,
    source_repo: src.repo,
    source_ref: src.ref,
    source_commit: sourceCommit,
    build_command: src.build,
    manifest_id: manifest.id,
    manifest_version: manifest.version,
    manifest_language: manifest.language || null,
    manifest_minimum_app_version: manifest.minimum_app_version || null,
    permissions_summary: manifest.permissions || null,
    scan_warnings: scanFindings,
    built_at: new Date().toISOString(),
  };
  await writeFile(join(outDir, "build-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");

  // Cleanup contents/ — we kept it only for validation
  await rm(contentsDir, { recursive: true, force: true });
  // Cleanup source/ — keep it if a future step needs to re-scan, but for
  // disk hygiene strip the cloned source after a successful build.
  await rm(sourceDir, { recursive: true, force: true });

  console.log(`\nbuild-plugin: OK ${id}@${version}`);
  console.log(`  archive: ${relative(REPO_ROOT, archiveDest)}`);
  console.log(`  sha256:  ${archiveSha256}`);
  console.log(`  size:    ${archiveSize} bytes`);
  if (scanFindings.length > 0) {
    console.log(`  scan warnings: ${scanFindings.length} (see build-receipt.json)`);
  }
}

main().catch((e) => {
  console.error("build-plugin failed:", e.message);
  process.exit(1);
});

# Submission guide

For plugin authors who want to publish a plugin to the Mallard marketplace.

## Before you submit

You'll need:

1. **A working Mallard plugin** — `.mallardx` you can build and that loads cleanly in Mallard (drag-drop sideload to test).
2. **A GitHub repo for your plugin source.** Public. Issue tracker on so users can report problems.
3. **A semver git tag** pointing at the commit you want published. The marketplace doesn't accept branch refs or arbitrary commits — only tags. You can re-tag if you make a mistake before submission lands.
4. **A reproducible build command.** Whatever you'd run in a fresh checkout to produce the `.mallardx`. For most Lua plugins this is `zip -qr myplugin.mallardx plugin.toml src ui`. For plugins with build steps (room-DB generation, asset compilation), include them.

## Submission format

One TOML file per (plugin, version) at `plugins/<your-plugin-id>/<version>.toml`. The id matches your `plugin.toml`'s `id` field; the version matches your `plugin.toml`'s `version` field. CI rejects mismatches.

Template:

```toml
[source]
repo     = "yourusername/your-plugin-repo"        # owner/name on github.com
ref      = "v0.1.0"                                # immutable git tag
build    = "zip -qr yourplugin.mallardx plugin.toml src ui"   # produces the artifact
artifact = "yourplugin.mallardx"                   # basename of produced file

[meta]
homepage = "https://github.com/yourusername/your-plugin-repo"
tags     = ["yourmud", "category", "panel"]        # lowercase + hyphen-safe
```

Worked example: see [`plugins/net.mallard.discworld-mapper/0.1.1.toml`](../plugins/net.mallard.discworld-mapper/0.1.1.toml).

### Optional but recommended: README and richer manifest fields

The marketplace surfaces three additional pieces of information in Mallard's in-app **plugin details modal**, all sourced from your plugin's repo (not the submission TOML):

- **`description`** in your `plugin.toml` (≤280 chars). One-line summary; renders as a subtitle on Browse cards, Installed rows, and the details modal header. Optional but strongly recommended — without it, your card looks bare next to plugins that have one.
- **`license`** and **`authors`** in your `plugin.toml`. The modal's by-line renders `by <authors> · <license> · <homepage> ↗`. Each segment is hidden if its data is missing.
- **`README.md` at the top level of your `.mallardx` archive** (≤64 KB markdown). Rendered into the details modal body. Supports GFM (tables, fenced code, links). Raw HTML is stripped, images become italic placeholders, and links open in the user's system browser. If your archive doesn't include a README, the modal shows "No README provided."

If your README exceeds 64 KB, `build-index.mjs` truncates with a `\n\n…` marker and the catalog publishes the truncated form. Authors usually don't want this — keep the README focused on what users need before installing.

## Submitting

1. **Fork** this repo.
2. **Add** your submission file at `plugins/<your-id>/<your-version>.toml`.
3. **Open a PR** against `wizardquack/mallard-marketplace:main`. Include in the PR body:
   - A one-paragraph description of what the plugin does.
   - Which MUDs it targets (or "any MUD" if generic).
   - A link to a screenshot if it adds a panel.
4. **Wait for CI.** The `PR validate` workflow will lint, clone your source at the declared tag, build the artifact, and run a warn-only security scan. Each step's output is in the workflow run; the build receipt and any scan warnings are uploaded as a workflow artifact and posted to the job summary.
5. **Address any errors.** Push updates to your fork; CI re-runs.
6. **Curator review.** A maintainer reads the diff + the build receipt + scan warnings + your PR description. They may ask questions or request changes.
7. **On merge**, the publish workflow signs your artifact with the marketplace key and deploys to GitHub Pages. Within ~5 minutes, your plugin appears in Mallard's Plugin Manager → Browse tab.

## What CI does

The `PR validate` workflow runs five steps:

1. **Lint** — validates your submission TOML against the schema. Fails on missing fields, malformed `repo` slug, branch-like `ref` values, etc.
2. **Clone + build** — clones your `source.repo` at `source.ref`, runs `source.build` in the cloned dir, validates the produced `.mallardx`:
   - id + version inside the archive's `plugin.toml` match the submission
   - archive size ≤ 20 MB (configurable but flagged for review)
   - no `.git`, `node_modules`, nested archives, etc.
3. **Scan** — grep heuristics for surprising patterns (Lua: `os.execute`, `io.popen`, `loadstring`, etc.; TS: `eval`, `child_process`). **Warn-only — never blocks**, but the curator will see warnings in the PR job summary and ask about anything that looks load-bearing.
4. **Dry-run sign** — signs the built artifact with a test key, just to confirm the sign path works end-to-end. Production signing happens only on merge.
5. **Staging index** — generates a candidate `index.json` against the PR's state and validates its schema.

If your build is non-deterministic (uses `Date.now()` in generated assets, makes outbound network calls during build, depends on environment variables not declared in the submission), CI runs will produce different SHAs across attempts. This won't fail validation but will surface as a curator question — please make builds deterministic.

## Versioning

Use [semver](https://semver.org/). Submit a new TOML file for each version: `plugins/<id>/0.1.0.toml`, `plugins/<id>/0.1.1.toml`, etc. Older versions stay in the catalog; the newest non-withdrawn version is what users see by default.

## Updating an existing plugin

Same as a fresh submission, just under a higher version number. The marketplace client compares installed version against the latest catalog version using semver and surfaces an update notification.

**Important**: if your update adds new permissions (compared to the previous published version), users see a "needs new permissions" badge and have to approve before the update installs. Permissions are extracted from your archive's `plugin.toml` — you don't need to declare them in the submission TOML.

## Withdrawing a version

If you ship a buggy version and want users to be warned:

```toml
[source]
# ... source block unchanged ...

[meta]
# ... meta block unchanged ...

withdrawn = true
withdrawn_reason = "Crashes on macOS WebKit; upgrade to 0.1.2 or later."
```

Submit as a PR editing the existing version's TOML. The archive stays served (users who already have it installed can still re-fetch) but the version is marked withdrawn in the catalog. Users see a "no longer in marketplace" badge.

## Hard removal

If you need a published version *fully removed* (e.g. it accidentally shipped credentials, has a copyright issue, is genuinely malicious): open an issue in this repo titled `EMERGENCY removal: <id>@<version>` describing the situation. The curator will follow [RUNBOOK §4.2](../RUNBOOK.md#42-hard-removal-emergency-only).

## Questions

Open an issue. Curator-driven; expect a response within a day or two.

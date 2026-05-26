# mallard-marketplace

The plugin registry for [Mallard](https://github.com/wizardquack/mallard) — a modern desktop MUD client.

This repo hosts:

- A **static `index.json` catalog** of available plugins, generated from submissions in `plugins/`.
- **Per-version `.mallardx` archives** + **detached `.minisig` signatures** under `archives/<id>/<version>/`.

Both are published to **<https://marketplace.mallardmud.app>** via GitHub Pages. Mallard's marketplace client (Plan #16, shipped) fetches the catalog from this URL and verifies each archive against an embedded marketplace public key before installing.

## Trust model

The marketplace is **curator-signed-only** for v1.0: a single maintainer holds the marketplace signing key, reviews every submission PR by hand, and merges only after CI passes. Every published archive carries a detached minisign signature produced by that key, which Mallard verifies before handing the archive to its install pipeline.

This is intentionally simple — no per-author identity, no telemetry, no ratings. See Mallard's roadmap for the v1.x evolution path.

## Submitting a plugin

See **[`docs/submission-guide.md`](docs/submission-guide.md)** for the step-by-step. The TL;DR:

1. Your plugin lives in its own GitHub repo and has a git tag for the version you want to publish.
2. Fork this repo.
3. Add `plugins/<your-plugin-id>/<version>.toml` declaring the source repo, the tag, the build command, and the artifact name. See `plugins/net.mallard.discworld-mapper/0.1.0.toml` for a worked example.
4. Open a PR. CI lints the submission, fetches the source, builds the `.mallardx`, runs a warn-only security scan, and publishes the receipt as a workflow artifact.
5. The curator reviews and merges. On merge, the publish workflow signs the archive with the production marketplace key and deploys to GitHub Pages.

## Repository layout

```
plugins/<id>/<version>.toml      One file per (plugin, version). Submissions.
scripts/                          Lint, scan, build, sign, index generators (Node ESM).
.github/workflows/                pr-validate.yml (PR) + publish.yml (main).
RUNBOOK.md                        Operational procedures: key rotation, plugin takedown, DNS.
docs/submission-guide.md          For plugin authors.
tests/fixtures/                   Test keypair for local dry runs (NOT the production key).
```

The generated catalog + archives live on the `gh-pages` branch (published, not committed to `main`).

## License

MIT. See [`LICENSE`](LICENSE).

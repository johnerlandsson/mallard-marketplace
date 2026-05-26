# Test keypair

This is the **test** minisign keypair used by:

- Local dry runs of the marketplace pipeline (`node scripts/dry-run.mjs`).
- The PR-validate CI workflow's dry-run sign step.

It is **NOT** the production marketplace signing key. The production key is generated separately at the operational hand-off (see [`../../RUNBOOK.md`](../../RUNBOOK.md) §Initial key generation) and never lives in any repo. It exists only as:

- An encrypted file in 1Password (maintainer's password manager).
- A GitHub Actions secret (`MARKETPLACE_SIGNING_KEY`) on this repo.

The same test keypair is committed in the Mallard repo at `src-tauri/tests/fixtures/marketplace/` for the marketplace client's integration tests. Both copies are byte-identical and intentionally so.

Passphrase for this test key: **empty string**. The interactive `minisign` prompt accepts hitting Enter immediately; scripted invocations pipe `""` to stdin.

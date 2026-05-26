# RUNBOOK

Operational procedures for the Mallard marketplace registry.

Audience: the curator/maintainer. Most users (plugin authors) don't need this — they want [`docs/submission-guide.md`](docs/submission-guide.md).

## Table of contents

1. [Initial setup (one-time)](#1-initial-setup-one-time)
2. [Bootstrap: first plugin publish](#2-bootstrap-first-plugin-publish)
3. [Submission review checklist](#3-submission-review-checklist)
4. [Plugin takedown](#4-plugin-takedown)
5. [Key rotation](#5-key-rotation)
6. [Disaster recovery: lost private key](#6-disaster-recovery-lost-private-key)
7. [GitHub Pages / DNS troubleshooting](#7-github-pages--dns-troubleshooting)

---

## 1. Initial setup (one-time)

Run once when bringing the marketplace online. After this is done, day-to-day operation is just reviewing + merging PRs.

### 1.1 Generate the production signing key

Perform on a trusted machine. Use a strong passphrase you can store securely.

```sh
cd ~/secure-scratch   # an offline scratch dir, NOT inside a repo
minisign -G -s mallard-marketplace.key -p mallard-marketplace.pub
```

You'll be prompted for a passphrase twice. Pick one ≥20 characters, mixed case + digits + symbols. **The passphrase is the lock on the encrypted private key — losing it = losing the key.**

Outputs:

- `mallard-marketplace.key` — encrypted private key (the file is ~280 bytes; the encryption uses the passphrase you just set)
- `mallard-marketplace.pub` — public key (single comment line + single base64 line)

Store **both files + the passphrase** in 1Password as a "Secure Note" attachment. Tag it `mallard-marketplace-signing-key`.

### 1.2 Create the GitHub repo

```sh
cd ~/code/mallard-marketplace
gh repo create wizardquack/mallard-marketplace --public --source=. --remote=origin --push
```

This creates the repo on GitHub and pushes the local `main` branch.

### 1.3 Provision GitHub Actions secrets

```sh
cd ~/code/mallard-marketplace
gh secret set MARKETPLACE_SIGNING_KEY < ~/secure-scratch/mallard-marketplace.key
gh secret set MARKETPLACE_SIGNING_PASSPHRASE   # paste passphrase when prompted; no trailing newline
```

Verify they exist:

```sh
gh secret list
# Expected:
# MARKETPLACE_SIGNING_KEY          Updated 2026-05-26
# MARKETPLACE_SIGNING_PASSPHRASE   Updated 2026-05-26
```

### 1.4 Configure GitHub Pages

In the repo settings → Pages:

- **Source**: `Deploy from a branch`
- **Branch**: `gh-pages` / `/ (root)`
- **Custom domain**: `marketplace.mallardmud.app`
- **Enforce HTTPS**: ✓

The `gh-pages` branch is created automatically by the first successful publish workflow run; you may need to come back to this step after step 1.7 completes.

### 1.5 Configure DNS

At the domain registrar managing `mallardmud.app`:

```
Type:  CNAME
Name:  marketplace
Value: wizardquack.github.io
TTL:   3600 (or shorter for faster propagation during setup)
```

Wait for propagation. Verify:

```sh
dig +short marketplace.mallardmud.app
# Expected: wizardquack.github.io.
```

### 1.6 Configure branch protection on `main`

In the repo settings → Branches → Add rule for `main`:

- **Require a pull request before merging**: ✓ (require 1 approval)
- **Require status checks to pass before merging**: ✓
  - **Required checks**: `validate` (from `pr-validate.yml`)
- **Restrict who can push to matching branches**: maintainer only

This is what enforces "no submission lands without a passing CI run and curator review."

### 1.7 Replace Mallard's placeholder pubkey

The Mallard client currently embeds the test fixture pubkey as a placeholder. Replace it with the production pubkey.

Open `~/code/mallard/src-tauri/src/marketplace/mod.rs` and locate:

```rust
pub const MARKETPLACE_PUBKEY: &str = include_str!("../../tests/fixtures/marketplace/test_minisign.pub");
```

Replace with a string literal containing the contents of `mallard-marketplace.pub` verbatim. The file is two lines (a comment + the base64 key). For example:

```rust
pub const MARKETPLACE_PUBKEY: &str = "untrusted comment: minisign public key 1A2B3C4D...
RWQ...real-base64-key-data...";
```

Also add the following guard test at the bottom of `src-tauri/src/marketplace/mod.rs`. It asserts that `MARKETPLACE_PUBKEY` differs from the test fixture pubkey in release builds — the safety net that prevents shipping the test key to real users:

```rust
#[cfg(test)]
mod release_guard {
    use super::MARKETPLACE_PUBKEY;

    /// Release builds (`cargo test --release`) fail loudly if `MARKETPLACE_PUBKEY`
    /// is still the test fixture key. Debug builds skip — local dev still
    /// uses the fixture via `include_str!` and shouldn't fail.
    #[test]
    #[cfg_attr(debug_assertions, ignore)]
    fn marketplace_pubkey_differs_from_test_fixture() {
        let test_fixture = include_str!("../../tests/fixtures/marketplace/test_minisign.pub");
        assert_ne!(
            MARKETPLACE_PUBKEY.trim(),
            test_fixture.trim(),
            "MARKETPLACE_PUBKEY is still the test fixture key — production builds would accept test-key-signed archives. Replace with the real key from #16b before release.",
        );
    }
}
```

Run it locally to confirm it fires when the pubkey hasn't been swapped:

```sh
cd ~/code/mallard
cargo test --manifest-path src-tauri/Cargo.toml --release \
  -p mallard-lib marketplace::release_guard:: -- --include-ignored
# Expected after the swap: passes.
# Expected if you forgot the swap: fails with the assertion message.
```

Open a PR in `wizardquack/mallard`, merge. Cut a Mallard release that includes this change. **Until this is done, marketplace-installed plugins won't verify against the catalog (Mallard is still trusting the test key).**

### 1.8 Cut the mapper's first tag

The bootstrap submission references `v0.1.1` of `wizardquack/mallard-discworld-mapper`. Cut it:

```sh
cd ~/code/mallard-discworld-mapper
# Confirm plugin.toml says version = "0.1.1" (or matching whatever the bootstrap submission targets)
grep '^version' plugin.toml
git tag -a v0.1.1 -m "First marketplace-published release"
git push origin v0.1.1
```

### 1.9 Trigger the publish workflow

If the secrets weren't set when the initial push happened, the first publish workflow run will have failed. Re-trigger by either:

- An empty commit: `git commit --allow-empty -m "Trigger publish after secrets" && git push`
- A manual run: in the repo's Actions tab → Publish → "Run workflow"

Watch the run. On success, `https://marketplace.mallardmud.app/index.json` returns the catalog and `/archives/net.mallard.discworld-mapper/0.1.1/` contains the `.mallardx` + `.minisig`.

### 1.10 Smoke-install from Mallard

In Mallard (the version with the production pubkey from step 1.7):

- Plugin Manager → Browse → Discworld Mapper should appear.
- Click Install. The permission dialog appears with **no untrusted-source banner** (it's signed by the marketplace key).
- Confirm install. Plugin appears in the Installed tab with the **Marketplace** source badge.
- Open the Map panel from the command palette / dock. Plugin works.

When this succeeds, the marketplace is launched. The next steps are routine: review PRs from plugin authors as they land.

---

## 2. Bootstrap: first plugin publish

Covered by step 1.8–1.10 above.

For future plugins (e.g. each extraction landing under Plan #16c), the pattern is:

1. Plugin author extracts their plugin into a standalone repo, cuts a release tag.
2. Plugin author opens a PR adding `plugins/<id>/<version>.toml` to this repo. PR-validate runs CI.
3. Curator reviews per [§3](#3-submission-review-checklist), merges.
4. Publish workflow signs + deploys. New version live within ~5 minutes.

---

## 3. Submission review checklist

When reviewing a PR adding or updating `plugins/<id>/<version>.toml`:

**Source trust:**
- [ ] Is `source.repo` an account/org you recognize, or has the author given a credible introduction in the PR description?
- [ ] Is `source.ref` a real git tag (CI enforces this, but spot-check)?
- [ ] Is the source repo public and reasonably-sized (not a 500 MB monorepo)?

**Build cleanliness:**
- [ ] PR-validate CI passed.
- [ ] No `size_cap_override` set; if present, is the justification reasonable?
- [ ] Scan warnings posted to the job summary — any that look genuinely surprising (not just a `loadstring` for sandboxed-config-eval)?

**Manifest sanity:**
- [ ] Plugin id follows the `tld.author.name` convention (e.g. `net.mallard.foo`, `io.github.user.bar`)?
- [ ] Plugin name + description are non-empty and not spammy?
- [ ] Permissions match what a plugin of this type plausibly needs? (e.g. a vitals panel asking for `sends: true` + `filesystem: ...` is suspicious; a chat capture asking for `keychain: true` is suspicious)

**Per-update concerns** (when reviewing a version-bump PR for an existing plugin):
- [ ] Permission diff: any *added* permissions? If yes, is the new feature documented in the PR description?
- [ ] If the new version supersedes a known-buggy old version, has the old version been marked `withdrawn = true`?

**On the fence?** Ask in the PR. The curator-signed-only model means the curator's review is the trust signal — better to ask twice than rubber-stamp.

---

## 4. Plugin takedown

Two flavors. Use the right one.

### 4.1 Soft withdrawal (preferred)

For "this version is buggy; users should upgrade" or "this plugin is unmaintained; we don't recommend new installs but existing users can keep it."

Edit `plugins/<id>/<version>.toml`:

```toml
withdrawn = true
withdrawn_reason = "Crashes on connect when MXP is disabled — upgrade to 0.2.0+. See <issue-link>."
```

PR + merge. The next publish workflow run regenerates `index.json` with the `withdrawn: true` flag. Mallard's marketplace client picks it up on next refresh and:

- Shows a "no longer in marketplace" badge for users with this version installed.
- Hides the version from the Browse tab unless the user has it installed.

The archive and signature stay served at the same URLs (so reinstall flows still work; some users may need to roll back temporarily).

### 4.2 Hard removal (emergency only)

For genuine emergencies: malware, copyright takedown, leaked credentials in a plugin. **Curator decision; documented before action.**

1. Open a draft PR titled `EMERGENCY: remove <id>/<version> — <reason>`. In the body, include the reason + link to source evidence + your decision rationale.
2. Add an entry to `removals.md` (create it if absent) with the same content. This is the public record.
3. Merge.
4. In a follow-up PR, delete `plugins/<id>/<version>.toml` AND directly edit `public/archives/<id>/<version>/` on the `gh-pages` branch to remove the archive + signature + manifest:
   ```sh
   git fetch origin gh-pages
   git checkout gh-pages
   git rm -r archives/<id>/<version>/
   git commit -m "EMERGENCY removal: <id>/<version> — see removals.md"
   git push
   ```
5. Run the publish workflow to regenerate `index.json` without the removed entry.

After hard removal, the URL returns HTTP 404. Mallard's marketplace client surfaces this as a network error on attempted reinstall — graceful enough.

---

## 5. Key rotation

**When to rotate**: planned (annual or biannual hygiene), or unplanned (suspected compromise — but if compromise is *known*, that's §6 disaster recovery).

This is a runbook, not an engineered protocol — Mallard has no in-band key rotation primitive. The procedure runs over multiple release cycles.

### 5.1 Generate the new key

```sh
cd ~/secure-scratch
minisign -G -s mallard-marketplace-NEW.key -p mallard-marketplace-NEW.pub
```

New passphrase. Store both files + passphrase in 1Password under a new note labeled with a date suffix.

### 5.2 Mallard release N+1: dual-key acceptance

Open a Mallard PR adding the new pubkey as a fallback:

```rust
// src-tauri/src/marketplace/mod.rs
pub const MARKETPLACE_PUBKEY: &str = "<NEW key contents>";
pub const MARKETPLACE_PUBKEY_LEGACY: Option<&str> = Some("<OLD key contents>");
```

Update `src-tauri/src/marketplace/verify.rs` so verification tries `MARKETPLACE_PUBKEY` first, falls back to `MARKETPLACE_PUBKEY_LEGACY` on `SignatureInvalid`. (If `MARKETPLACE_PUBKEY_LEGACY` is `None`, no fallback.)

Ship that Mallard release. **Important**: at this point Mallard accepts archives signed by either key, but the marketplace is still signing with the OLD key — that's intentional. Users update to the new Mallard at their pace.

### 5.3 Wait one release cycle

Give users 4+ weeks to update. Monitor uptake via your usual signal (download count on the release page, telemetry if/when v1.x adds it).

### 5.4 Rotate the GitHub Actions signing secret

```sh
cd ~/code/mallard-marketplace
gh secret set MARKETPLACE_SIGNING_KEY < ~/secure-scratch/mallard-marketplace-NEW.key
gh secret set MARKETPLACE_SIGNING_PASSPHRASE   # paste new passphrase
```

Manually trigger the publish workflow (Actions → Publish → Run workflow). All existing archives get re-signed with the NEW key, replacing their `.minisig` files in place.

At this point: marketplace serves archives signed by the new key. Mallard release N+1 verifies them via `MARKETPLACE_PUBKEY` (the new one); Mallard releases ≤N still verify them via `MARKETPLACE_PUBKEY_LEGACY` (no — wait, they don't know about the new key. They'd fail.)

Correction to the above: the dual-acceptance is BEFORE the rotation. Mallard release N+1 ships with the new key already as `MARKETPLACE_PUBKEY` and the old key as legacy. So after rotation, Mallard release N+1 sees archives signed by the new key → verifies with `MARKETPLACE_PUBKEY` (new). Older Mallard releases (≤N) still have only the old key embedded → they CANNOT verify newly-signed archives. **This is why §5.3 says wait a release cycle.** Older Mallard installs that haven't updated yet are temporarily broken for new installs/updates. They keep working for already-installed plugins; only the marketplace tab fails until they update.

If aggressive support for older versions is required, an alternative: re-sign with BOTH keys in parallel during the transition (publish two `.minisig` files per archive). Not currently engineered. Future v1.x if needed.

### 5.5 Mallard release N+2: drop legacy

After another release cycle (or as soon as you're satisfied uptake of N+1 is sufficient), open a Mallard PR removing `MARKETPLACE_PUBKEY_LEGACY` and the verify-fallback path. Ship. Rotation complete.

### 5.6 Securely destroy the old key

```sh
shred -u ~/secure-scratch/mallard-marketplace.key
# Remove the 1Password note for the old key (archive or delete).
```

---

## 6. Disaster recovery: lost private key

If you can't access the production private key — laptop lost, 1Password vault corrupted, GitHub Actions secret accidentally rotated to garbage, passphrase forgotten:

1. **Do not panic.** Existing archives stay served and stay verifiable (the signatures don't expire; users already-installed are fine).
2. Generate a fresh key per §5.1.
3. Open a Mallard PR: `MARKETPLACE_PUBKEY` swaps to the new key directly (no legacy fallback — the legacy key is unrecoverable, so dual-acceptance doesn't help). Ship the release.
4. Re-sign all archives by running the publish workflow with the new key (per §5.4).
5. **Users on the old Mallard release cannot install new plugins until they update.** Communicate via release notes.

The cost of losing the private key: a forced fast rotation with a coordinated Mallard release. Worth taking the backup practice seriously.

---

## 7. GitHub Pages / DNS troubleshooting

### Pages says 404 for everything

- Check Pages settings — source is `gh-pages` branch, root path.
- Check the `gh-pages` branch exists (`git ls-remote --heads origin gh-pages`). It's created by the first publish workflow run.
- Wait 5 minutes after a fresh deploy — propagation is slow on first publish.

### Custom domain says "DNS check failed"

- Verify CNAME record: `dig +short marketplace.mallardmud.app` should return `wizardquack.github.io.`
- Wait for DNS propagation (up to 24h, usually under an hour).
- In Pages settings, click "Check again" once DNS resolves.

### HTTPS certificate not issued

- Pages auto-provisions Let's Encrypt certs but only after the domain resolves.
- Untick + re-tick "Enforce HTTPS" to retry.
- If still failing after 24h, open a GitHub support ticket.

### `index.json` is stale after a successful publish

- GitHub Pages CDN can take 1–10 minutes to invalidate.
- `curl -fsSL "https://marketplace.mallardmud.app/index.json?cb=$(date +%s)"` (cache-buster query string forces a re-fetch).
- The publish workflow's smoke step already runs a `curl` 30 seconds after deploy; if that passed, the catalog is live.

### Mallard client sees signature failures after a deploy

- Confirm the `MARKETPLACE_PUBKEY` in the Mallard release matches the production pubkey.
- Confirm the publish workflow used the production secret (check the workflow log — the "Restore signing key" step echoes the secret length, not the contents).
- Try `minisign -V -p <pubkey-file> -m <archive>` locally on the deployed archive — same exit code as Mallard would compute.

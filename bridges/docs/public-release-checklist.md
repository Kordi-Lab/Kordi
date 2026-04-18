# Public Release Checklist

Use this checklist before exporting or releasing the public self-host beta edition of Bridges.

## A. Scope review

- [ ] Confirm this release is intended for self-hosted/local group testing
- [ ] Confirm hosted-product-only work stays private
- [ ] Confirm the public repo contents match `public-beta-allowlist.txt`

## B. Sensitive data review

- [ ] No `.env` files with real values are tracked
- [ ] No private keys, service secrets, cloud credentials, or live API tokens are tracked
- [ ] No local state such as `.bridges/`, `*.db`, or user config files are tracked
- [ ] No personal machine paths or usernames remain in public docs unless intentionally generic
- [ ] No production-only hardcoded domains remain in public-facing docs/examples unless explicitly intended

Suggested checks:

```bash
rg -n --hidden --glob '!.git' --glob '!node_modules/**' \
  --glob '!target/**' --glob '!dist/**' \
  '(BEGIN (RSA|DSA|EC|OPENSSH) PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z\-_]{35}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|bridges_sk_[A-Za-z0-9_\-]{16,})' .

git log --all --oneline -G 'BEGIN (RSA|DSA|EC|OPENSSH) PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z\-_]{35}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}' -- .
```

## C. Documentation review

- [ ] `README.md` explains the product and self-host quickstart clearly
- [ ] `docs/self-host-guide.md` gives a complete server + agent setup path for beta users
- [ ] setup examples use placeholders like `<COORDINATION_URL>` rather than private infra
- [ ] `docs/test-guide.md` is usable by external beta groups
- [ ] `docs/e2e-test-guide.md` is usable by two external testers
- [ ] `skills/bridges/SKILL.md` is portable across agent runtimes

## D. Build and test gates

### Rust
- [ ] `cargo fmt --manifest-path cli/Cargo.toml --check`
- [ ] `cargo clippy --manifest-path cli/Cargo.toml -- -D warnings`
- [ ] `cargo test --manifest-path cli/Cargo.toml`

### Registry
- [ ] `cd registry && npm ci`
- [ ] `cd registry && npm run build`
- [ ] `cd registry && npm rebuild better-sqlite3`
- [ ] `cd registry && npm test`

### Root package
- [ ] `npm pack --dry-run`
- [ ] `npm run build`
- [ ] `npm test`

### Optional end-to-end smoke
- [ ] `npm run smoke:tmux`

## E. Packaging review

- [ ] npm tarball contains only expected public assets
- [ ] skill files are included in the package
- [ ] packaged binaries are present and executable
- [ ] lockfiles needed for reproducibility are committed

Suggested check:

```bash
npm pack --dry-run
```

## F. Public repo export

- [ ] export with `scripts/export-public-beta.sh`
- [ ] inspect the output tree before pushing
- [ ] initialize or update the separate public repo from the sanitized snapshot
- [ ] use squashed/fresh public history if needed for risk reduction

Example:

```bash
bash scripts/export-public-beta.sh /tmp/bridges-public
```

## G. Release

- [ ] create/update changelog entry for the beta release
- [ ] tag prerelease version (for example `v0.0.1-beta`)
- [ ] publish npm beta tag
- [ ] create GitHub prerelease
- [ ] share install + self-host test guide with beta groups

# Contributing to Kordi

Thanks for helping build Kordi. This repository uses GitHub issues, pull requests, CI, and local git hooks to keep `main` stable while the team collaborates.

## Prerequisites

- Rust with `cargo`, `rustfmt`, and `clippy`
- Node.js 22+
- pnpm 10.29.3+

Install JavaScript dependencies once after cloning:

```bash
pnpm install --frozen-lockfile
```

## Branch workflow

1. Start from an issue.
2. Create a branch from `main`:

   ```bash
   git checkout main
   git pull origin main
   git checkout -b feat/issue-123-short-description
   ```

3. Open a draft PR early if the work needs feedback.
4. Link the PR to the issue with `Closes #123` or `Refs #123`.
5. Merge only after review and green CI.

## Local git hooks

Install repo-managed hooks:

```bash
bash scripts/setup-git-hooks.sh
```

This sets:

```bash
git config core.hooksPath .githooks
```

### Pre-commit

Runs fast checks before a commit is created:

```bash
cargo fmt --all -- --check
git diff --check --cached
pnpm --dir app/desktop typecheck
pnpm --dir app/desktop lint
```

### Pre-push

Runs slower checks before pushing:

```bash
cargo test -p kordi-session
cargo test -p kordi-cli --lib
cargo test -p kordi-cli desktop_runtime --no-default-features
pnpm --dir app/desktop build
bash scripts/check-hygiene.sh
```

For emergency-only bypasses:

```bash
KORDI_SKIP_HOOKS=1 git commit -m "..."
KORDI_SKIP_HOOKS=1 git push
```

Do not use bypasses for normal development.

## Manual checks

Frontend:

```bash
pnpm check:frontend
```

Rust formatting:

```bash
pnpm check:rust:fmt
```

Rust clippy:

```bash
pnpm check:rust:clippy
```

Clippy currently runs as a baseline signal without `-D warnings`; the command allows the existing `clippy::never_loop` legacy lint so CI can stay green while the warning backlog is cleaned up in follow-up work.

Rust tests:

```bash
pnpm check:rust:test
```

Repository hygiene:

```bash
pnpm check:hygiene
```

This checks committed changes against `origin/main` plus staged and unstaged edits. Set `KORDI_HYGIENE_BASE=<ref>` when your branch targets a different base.

Full local CI equivalent:

```bash
pnpm check:ci
```

`check:rust:clippy` and the desktop Tauri crate test create ignored sidecar placeholders under `app/desktop/src-tauri/binaries/`. These are test-only files and should not be committed.

## Pull request checklist

Before requesting review, make sure:

- [ ] The PR links to an issue.
- [ ] CI is green.
- [ ] UI changes include screenshots or a short video.
- [ ] Light and dark modes were checked for UI changes.
- [ ] Window resizing / split-view was checked for layout changes.
- [ ] New behavior has tests or a clear manual validation note.
- [ ] No debug logs, secrets, or generated files were committed.

## GitHub branch protection

Maintainers should protect `main` with:

- Require a pull request before merging.
- Require at least one approval.
- Require status checks to pass.
- Require branches to be up to date before merging.
- Require conversation resolution before merging.
- Block force pushes.
- Block branch deletion.

Recommended required checks:

- `Desktop frontend`
- `Rust checks`
- `Repository hygiene`

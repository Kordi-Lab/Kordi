# CI check inventory

This document describes the shared check contract for the Kordi repository: which
check groups exist, what each one runs, which paths select it, and how to add a
new check. The machine-readable source of truth is
[`scripts/ci/check-inventory.json`](../scripts/ci/check-inventory.json); workflow
YAML provisions runners, caches, permissions, and reporting only and must not
define a second copy of a test command.

The selection engine is [`scripts/ci/select-checks.mjs`](../scripts/ci/select-checks.mjs).
It produces a versioned expected-work manifest that CI jobs and the merge gate
consume. The runner is [`scripts/ci/run-check.mjs`](../scripts/ci/run-check.mjs).

## Groups

| Group | Workflow | Command | Runner | Prerequisites | Timeout | Outputs |
| --- | --- | --- | --- | --- | --- | --- |
| `frontend` | `ci-frontend.yml` | `pnpm check:frontend` | `ubuntu-latest` | node, pnpm | 30 min | unit tests, typecheck, lint, web build |
| `visual` | `ci-visual.yml` | `pnpm check:visual` | `macos-15` | node, pnpm, Playwright Chromium | 30 min | Chromium screenshot comparison |
| `browser` | `ci-visual.yml` | `pnpm check:browser` | `macos-15` | node, pnpm, Playwright Chromium | 30 min | production entrypoint checks, transcript trajectory checks |
| `server` | `ci-rust.yml` | `pnpm check:server` | `ubuntu-latest` | cargo | 60 min | rustfmt, clippy, session/provider/tools/cloud-agent-runner/CLI/desktop-runtime/cloud-server tests |
| `migrations` | `ci-rust.yml` | `pnpm check:migrations` | `ubuntu-latest` | cargo, pinned PostgreSQL | 45 min | database upgrade matrix, cloud agent runtime e2e, chat sync e2e |
| `desktop` | `ci-platforms.yml` | `pnpm check:desktop` | `macos-15` | cargo, Xcode | 45 min | Tauri dependency surface, Tauri clippy, Tauri crate tests |
| `ios` | `ci-platforms.yml` | `pnpm check:ios` | `xcode-27` | Xcode 27.0 | 30 min | unsigned iOS simulator compilation |
| `hygiene` | `ci-hygiene.yml` | `pnpm check:hygiene` | `ubuntu-latest` | node, pnpm, git | 15 min | privacy baseline, whitespace, maintainability ratchet, ESLint suppression ratchet, script tests |

Selection paths per group are listed in the inventory. Groups without a
path filter (`always: true`) run for every change.

## Reference environments

- Node.js 22 and pnpm 10.29.3 (see `packageManager` in `package.json`).
- Rust stable with `rustfmt` and `clippy` from the repository toolchain; use the
  committed `Cargo.lock` and `pnpm-lock.yaml`.
- `visual` and `desktop` use the `macos-15` reference runner. `visual`
  requires the validated macOS environment because snapshot names
  include the platform (`-darwin.png`). Do not move screenshot comparison to
  Linux without reviewing and regenerating baselines.
- `ios` uses the `xcode-27` image with Xcode 27.0 selected explicitly, matching
  the reference toolchain the iOS app is developed and released with. The image
  is a GitHub preview and may queue; move to the stable label once it is
  generally available. The workflow fails loudly if the pinned Xcode path is
  missing.
- `browser` runs the Chromium production-entrypoint and trajectory suites on
  the `macos-15` reference runner initially. It may move to Linux only after
  portability is validated on a test pull request. Install Playwright Chromium
  before running it.
- `migrations` uses the pinned PostgreSQL version from
  `scripts/test-cloud-migrations.sh`: a `postgres:16.14-alpine` container by
  default, or `KORDI_MIGRATION_PG_BIN` when `scripts/prepare-ci-postgres.sh`
  prepared native binaries.
- `ios` compiles the shared `Kordi Beta` scheme unsigned for the iOS Simulator
  with `CODE_SIGNING_ALLOWED=NO` and `CODE_SIGNING_REQUIRED=NO`. No signing or
  distribution credentials are required.

## Selection policy

`scripts/ci/select-checks.mjs` compares the changed paths between a base and a
head revision and marks each group applicable or not applicable with an explicit
reason.

- A group applies when any changed path matches one of its `paths` patterns.
- `always: true` groups (hygiene) apply to every change.
- Shared build and check infrastructure paths apply to **all** groups:
  `pnpm-lock.yaml`, `Cargo.lock`, root `package.json`, root `Cargo.toml`,
  `rust-toolchain*`, `pnpm-workspace.yaml`, `tsconfig*.json`,
  `.github/workflows/**`, `scripts/ci/**`, `scripts/prepare-ci-postgres.sh`,
  `scripts/test-cloud-migrations.sh`,
  `scripts/prepare-tauri-sidecar-placeholders.sh`.
- Documentation-only changes (`**/*.md`, `docs/**`, `.github/assets/**`,
  `LICENSE`) mark every non-hygiene group not applicable with an explicit
  reason and keep hygiene applicable. Shared-path matches take precedence over
  the documentation-only classification.
- A changed path that matches no group and is not documentation triggers **all**
  groups with a conservative reason.
- If the diff cannot be computed (missing revisions, not a git repository, git
  failure), the manifest is emitted with `"fallback": true` and every group
  applicable. Coverage is never silently reduced.
- A deletion selects the group that owned the deleted path. A rename selects
  both the old and the new path.
- Malformed input (unknown flags, invalid SHA values, unreadable or empty
  changed-file lists, absolute or parent-directory entries) exits non-zero
  without emitting a manifest.

### Manifest

```json
{
  "version": 1,
  "base": "<sha>",
  "head": "<sha>",
  "mode": "diff",
  "fallback": false,
  "generatedBy": "scripts/ci/select-checks.mjs",
  "groups": [
    { "id": "frontend", "applicable": true, "reason": "changed path matched: app/desktop/src/App.tsx" }
  ]
}
```

`mode` is `diff` or `all`. `base` and `head` are `unknown` when the caller
injects a changed-file list without revisions. Group order matches the
inventory, and the JSON output is deterministic.

## Local usage

```bash
# Select checks for the local branch compared with origin/main, including
# committed, staged, unstaged, and untracked changes.
pnpm select:checks

# Reproduce selection for explicit revisions.
pnpm select:checks --base <base-sha> --head <head-sha>

# Request the complete suite.
pnpm select:checks --all

# Write the manifest for another tool.
pnpm select:checks --json --out .build/ci/selection.json

# Run the selected checks.
pnpm check:ci
pnpm check:ci --base <base-sha> --head <head-sha>
pnpm check:ci --all

# Run one group directly. --dry-run prints the shared command.
pnpm check:frontend
pnpm check:visual
pnpm check:browser
pnpm check:server
pnpm check:migrations
pnpm check:desktop
pnpm check:ios
pnpm check:hygiene
node scripts/ci/run-check.mjs ios --dry-run
```

`pnpm check:ci` displays the comparison and the selected checks before running
them. It stops at the first failing or unavailable group and exits non-zero. A
platform check whose prerequisites are missing (for example `ios` without
Xcode) reports an explicit unavailable result and exits with code 3; it is never
reported as passing. `KORDI_CHECK_PLATFORM` overrides platform detection for
tests.

### Hygiene comparison in CI

`pnpm check:hygiene` runs `scripts/ci/run-hygiene.sh`. When `KORDI_CI_BASE` and
`KORDI_CI_HEAD` are set (`KORDI_HYGIENE_BASE` is accepted as a base fallback),
the wrapper passes the explicit `base...head` comparison to the privacy guard,
the whitespace check, and both ratchets, with the head defaulting to `HEAD`.
Without those variables the wrapper keeps the local defaults: `origin/main` for
the ratchets and the committed plus working-tree scope for whitespace.
`bash scripts/ci/run-hygiene.sh --print-plan` prints the resolved commands
without running them.

## How to add a check

1. Add or reuse a `pnpm` script in the root `package.json` that runs the check
   from a clean checkout. Do not duplicate the command in workflow YAML.
2. Add a group entry to `scripts/ci/check-inventory.json` with the required
   schema fields: `id`, `title`, `workflow`, `command`, `runner`,
   `prerequisites`, `paths`, `always`, `serial`, `timeoutMinutes`, and
   `outputs`. Reuse an existing group when the check belongs to one.
3. Extend `scripts/ci/check-contract.test.mjs` expectations if the group adds a
   new id, runner, or command.
4. Add selection fixtures to `scripts/ci/select-checks.test.mjs` for the new
   paths, including a deliberately failing input when the check has a negative
   case.
5. Map the group to a workflow in the CI runner allocation and make that
   workflow consume the manifest instead of guessing applicability.
6. Update this document's group table.

Run the contract tests after every change:

```bash
node --test scripts/ci/*.test.mjs
```

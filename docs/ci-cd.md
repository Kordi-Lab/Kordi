# CI/CD contract

This document describes the shared check contract, change analysis, merge gate,
failure diagnostics, and deployment controls for Kordi. The reviewed inventory at
`scripts/ci/check-inventory.json` is the source of truth for check groups,
commands, runners, prerequisites, and expected outputs. Workflow YAML handles
provisioning, caching, permissions, scheduling, and reporting only; it does not
maintain a second implementation of test commands.

The persistent self-hosted PR runner is retired in Phase 0A. Public PR execution
runs on standard GitHub-hosted runners and uses no deployment or signing
credentials.

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node | 22 | Pinned in every workflow through `actions/setup-node`. |
| pnpm | 10.29.3 | Matches `packageManager`; workflows pin the same version. |
| Rust | stable | `rustfmt` and `clippy` components are installed for server checks. |
| PostgreSQL | 16.14 | Migration checks use the pinned `postgres:16.14-alpine` container, or the pinned source build from `scripts/prepare-ci-postgres.sh` when containers are unavailable. |
| Playwright Chromium | `@playwright/test` 1.61.1 from `app/desktop` | Installed per visual and browser job. |
| macOS reference | `macos-15` | Visual baselines and Tauri compilation. |
| iOS toolchain | `xcode-27` image with Xcode 27.0 pinned by path | Unsigned iOS simulator compilation only. The image is a GitHub preview and may queue; move to the stable label at GA. No signing or distribution credentials exist in these jobs. |

A frontend-only contribution never allocates an Apple platform job and never
requires local Xcode. An applicable platform check with missing prerequisites
returns an actionable failure or unavailable result, never success.

## Command mapping

Run `pnpm check:ci` locally to run the checks selected for the current change,
`pnpm check:ci --base <sha> --head <sha>` to reproduce selection for explicit
revisions, and `pnpm check:ci --all` to request the complete suite. Each group is
also runnable directly:

| Group | Command | Runner | Scope |
| --- | --- | --- | --- |
| `frontend` | `pnpm check:frontend` | `ubuntu-latest` | Frontend unit tests, applicable catalog/generated checks, typecheck, lint, and web build. |
| `visual` | `pnpm check:visual` | `macos-15` reference | Screenshot comparison against the documented reference environment. |
| `browser` | `pnpm check:browser` | `macos-15` reference initially | Production-entrypoint and transcript-trajectory browser suites. |
| `server` | `pnpm check:server` | `ubuntu-latest` | Portable fmt/lint/core/server Rust checks with the same features and test concurrency as CI. |
| `migrations` | `pnpm check:migrations` | `ubuntu-latest` | Synthetic database upgrade matrix in the pinned PostgreSQL test environment. |
| `desktop` | `pnpm check:desktop` | `macos-15` | macOS/Tauri compilation checks. |
| `ios` | `pnpm check:ios` | `xcode-27`, Xcode 27.0 pinned | Unsigned iOS simulator compilation (`app/ios`, `Kordi Beta` scheme, `CODE_SIGNING_ALLOWED=NO`; no signing credentials). |
| `hygiene` | `pnpm check:hygiene` | `ubuntu-latest` | Secret-free privacy baseline, whitespace, ratchets, script tests, generated-file checks, and workflow validation. |

The hygiene workflow additionally runs `actionlint` (pinned binary with a
verified checksum) over `.github/workflows/**`. If the inventory and this table
disagree, the inventory wins and this table is corrected.

## Change selection and the expected-work manifest

The `changes` job in `blocking-ci.yml` runs first on Linux with full history:

```bash
node scripts/ci/select-checks.mjs --base <base-sha> --head <tested-sha> --out ci-manifest.json
```

The selector supports `--all`, `--changed-files <path>`, `--out <path>`, and
`--json`. It writes a versioned manifest:

```json
{
  "version": 1,
  "base": "<base sha>",
  "head": "<tested sha>",
  "mode": "changed",
  "fallback": false,
  "generatedBy": "scripts/ci/select-checks.mjs",
  "groups": [{ "id": "frontend", "applicable": true, "reason": "..." }]
}
```

- `head` is the exact tested revision. For pull requests this is the synthetic
  merge commit from `refs/pull/<number>/merge`, not the source-branch tip.
- Unknown paths, incomplete diffs, missing metadata, or selector errors trigger
  conservative full coverage: `changes` validates the manifest and, on failure,
  writes a fallback manifest with every group applicable and `fallback: true`.
- `changes` uploads the manifest as the `ci-expected-work` artifact and passes it
  to every reusable child workflow. Children never guess applicability.
- To reproduce a tested merge revision locally:

  ```bash
  git fetch origin pull/<number>/merge
  git checkout <tested-sha>
  pnpm check:<group>
  ```

## Merge gate semantics

`blocking-ci.yml` exposes one stable terminal check, `CI required`. The job runs
with `if: always()`, collects each child workflow's machine-readable completion
results, and validates them against the manifest and the expected revision.
Repository protection must require that exact check from its intended source.

| Observed result | Gate outcome |
| --- | --- |
| Applicable group ran for the expected revision and passed | Pass for that group. |
| Manifest explicitly marks a group not applicable with a reason | Pass with the visible not-applicable reason. |
| Group failed, timed out, was cancelled, was unexpectedly skipped, or produced no valid result | Fail. |
| Manifest or result is missing, malformed, inconsistent, or references another revision | Fail, or the conservative full suite runs first and is evaluated normally. |

Each child emits `{ "group", "applicable", "executed", "outcome", "sha", "runId" }`
from a lightweight completion job. Raw `skipped` is not evidence of success: a
skipped applicable group fails with `unexpected-skip`, and a missing result fails
with `missing-result`. A wrapper that omits required jobs cannot pass.

Gate test fixtures live in `scripts/check-ci-results.test.mjs` and cover success,
real failure, timeout, cancellation, unexpected skip, legitimate not-applicable,
missing outputs, stale-SHA outputs, invalid manifests, detector failure, and
fallback manifests. Run them with:

```bash
node --test scripts/check-ci-results.test.mjs
```

The gate validator also provides the completion writer used by workflows
(`emit`), the manifest validator (`check-manifest`), the child applicability
query (`applicable`), and conservative manifest generation (`full-manifest`).
Run `node scripts/check-ci-results.mjs help` for the full interface.

## Failure diagnostics

- Every completion result carries the group, applicability, execution state,
  outcome, tested SHA, and run id. The gate report and the job summary list each
  group's status and the failure code (`failed`, `timed-out`, `cancelled`,
  `unexpected-skip`, `missing-result`, `stale-revision`, `invalid-manifest`,
  `malformed-result`, `inconsistent-applicability`, `duplicate-result`).
- Each failure summary includes the exact tested revision, the check or step, the
  first useful error, the local reproduction command, the relevant prerequisites,
  artifact links, and an owner hint.
- Reproduce with `git checkout <tested-sha>` and `pnpm check:<group>`; platform
  groups list their prerequisites in the command mapping above.
- Classify code/test failures separately from runner, network, or service
  failures, and keep an unknown category when evidence is insufficient.
- Visual failures publish expected, actual, and difference images plus the HTML
  report. Browser failures capture traces on failure where supported.
  Compilation failures surface compiler diagnostics rather than only the build
  tool's final error line.
- Diagnostics use synthetic inputs and redacted logs. Reruns are targeted and
  justified; a persistent failure is never converted to success through
  unbounded retries.

## Visual baseline generation

Visual snapshots are platform-specific (`snapshotPathTemplate` includes
`{platform}`) and are only generated in the documented reference environment
(`macos-15`, pinned Playwright, pinned browser, image fonts). Regenerate
baselines with:

```bash
pnpm --dir app/desktop exec playwright test -c playwright.visual.config.ts --project chromium --update-snapshots
```

Review every changed image before committing it, explain the toolchain or
rendering change in the PR, and never accept all changed screenshots
automatically. A migration away from the macOS reference requires new baselines
to be reviewed and the reference environment documented here before the switch.

## Verification and measurement

Baseline timings, queue waits, and the administrative verification of branch
protection, runner registration, environment protection, concurrency, and
billing settings are recorded in the tracking issue (#1590). Cold-cache runs are
tracked separately from warm runs, every check has a timeout, and target changes
require a recorded reason.

## Owner escalation

The primary owner is `@shuyhere`. Backup owners are recorded in
`.github/CODEOWNERS`; add at least one eligible backup before enabling required
owner review. Sensitive paths (workflows, selection and gate policy, shared
check infrastructure, `CODEOWNERS`, deployment and release tooling, Tauri
configuration, and signing/version sources) require an eligible `CODEOWNER`
approval, and that same approval may satisfy the normal one-review requirement.
When no owner is available, request an eligible backup in the pull request
rather than merging sensitive changes unreviewed. Administrative bypasses must
be recorded in the pull request and re-reviewed afterwards.

## Deployments

- Development deployment remains `workflow_dispatch` only until the self-service
  phase lands; production deployment stays in the protected production
  environment with an eligible reviewer. This phase does not change deployment
  automation.
- PR workflows receive read-only repository access, no production, signing, or
  deploy secrets, and no `secrets: inherit`.
- `postmerge-ci.yml` runs the complete suite on `main` plus a broader workspace
  test matrix and an unsigned desktop build smoke. Its stable aggregator is
  `Post-merge CI required`, and it is the required release-candidate readiness
  check together with `CI required`.
- A production candidate must have successful `CI required` and
  `Post-merge CI required` checks for its exact `main` SHA, including required
  readiness checks. A green pull-request merge-ref check on a different revision
  is not sufficient evidence.

## Locking

- GitHub Actions concurrency is not a deployment lock. `blocking-ci.yml` cancels
  in-progress runs only for pull requests and groups by PR number or SHA, so
  distinct `main` revisions are never silently displaced. `postmerge-ci.yml`
  groups by SHA with no cancellation.
- Deployment locking is delivered in Phase 1 (#1592) and is shared by laptop and
  workflow operator paths, with documented ownership, timeout, crash recovery,
  and cleanup.

## Backups

- Production deployment requires a validated pre-deploy backup, recorded schema
  compatibility, and a rollback plan before rollout (Phase 3, #1594). Deployment
  records include the environment, SHA, actor, artifact digests, backup
  identifier, verification summary, and rollback outcome.
- Database restore and application rollback are distinct procedures.

## Rollback

- Desktop channel rollback uses the existing release tooling:
  `pnpm release:rollback-desktop-beta` and
  `pnpm release:clear-desktop-acceptance`; see `docs/release.md`.
- Incompatible database migrations require an explicit forward-fix or restore
  strategy. Rehearse rollback and restore on non-production data before relying
  on either in production.

## Secrets

- Pull-request checks use no secrets. The only optional repository secret is
  `KORDI_PRIVACY_DENYLIST` for the private denylist integration; the mandatory
  public privacy baseline is secret-free and must not depend on it.
- Release and signing secret names are documented in `docs/release.md`. Those
  credentials are never available to PR execution or to reusable check
  workflows.

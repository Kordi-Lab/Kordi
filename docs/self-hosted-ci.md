# Self-hosted macOS CI runner

Kordi uses a repository-scoped Apple Silicon macOS runner when GitHub-hosted
compute is unavailable. The runner preserves the Darwin visual snapshots and
runs the same frontend, visual, Rust, hygiene, and pull-request metadata checks.

## Security boundary

- Install the runner only on a dedicated development Mac, never on a production
  server. Follow [Development environment isolation](development-environments.md)
  before using any shared development or product infrastructure.
- The runner uses the hidden, non-admin `kordi-ci` account and its private
  `kordi-ci` group. Its home is mode `700` and its login shell is disabled. Do
  not add that account to `admin` or `staff`, grant it Full Disk Access, or sign
  it into iCloud.
- Do not expose production database, provider, updater-signing, Apple signing,
  operator, SSH, or Google Cloud credentials to workflows.
- Keep the runner scoped to this private `Kordi-Lab/Kordi` repository and limit
  write access to trusted collaborators. Pull-request code executes before it
  is merged; never attach this runner to a public repository.
- The runner needs outbound HTTPS access to GitHub and package registries. It
  does not need inbound network access.

## Install

Prerequisites are Xcode Command Line Tools and an administrator account. Run the
following from a clean checkout. The GitHub CLI account must have repository
administration permission.

1. In GitHub's **Settings > Actions > Runners > New self-hosted runner**, select
   macOS and ARM64. Download the current archive and copy the SHA-256 value shown
   by GitHub. Do not run GitHub's `config.sh` command directly.
2. Create a short-lived repository registration token without printing it:

   ```bash
   umask 077
   gh api --method POST \
     repos/Kordi-Lab/Kordi/actions/runners/registration-token \
     --jq .token > /tmp/kordi-ci-registration-token
   ```

3. Run the audited installer, substituting the downloaded archive and checksum:

   ```bash
   sudo bash scripts/install-macos-self-hosted-runner.sh \
     --archive "$HOME/Downloads/actions-runner-osx-arm64-VERSION.tar.gz" \
     --sha256 SHA256_FROM_GITHUB \
     --token-file /tmp/kordi-ci-registration-token
   ```

The installer verifies the archive before reading the token, deletes the token
file immediately, creates or reuses the standard `kordi-ci` account, registers
the default `self-hosted`, `macOS`, and `ARM64` labels plus `kordi-ci`, and starts
`io.kordi.github-actions-runner` as a system LaunchDaemon.

## Verify

The runner should report `online`, `idle`, and all four labels:

```bash
gh api repos/Kordi-Lab/Kordi/actions/runners \
  --jq '.runners[] | {name, status, busy, labels: [.labels[].name]}'
sudo launchctl print system/io.kordi.github-actions-runner
```

Logs are stored under
`/Users/kordi-ci/Library/Logs/KordiCI/` and runner diagnostics under
`/Users/kordi-ci/actions-runner/_diag/`.

## Caches and maintenance

pnpm, Playwright, Rust toolchains, and Cargo registries persist in the isolated
home directory. Rust build artifacts use
`/Users/kordi-ci/Library/Caches/kordi-ci/cargo-target`. GitHub-hosted cache
services are intentionally not used. GitHub's runner updates itself; repeat the
installation steps only when replacing a broken installation or performing a
controlled runner upgrade.

Keep the Mac awake and connected while checks are queued. Review disk use with:

```bash
sudo du -sh /Users/kordi-ci/actions-runner /Users/kordi-ci/Library/Caches/kordi-ci
```

## Recovery and removal

If the runner is unhealthy, remove it from GitHub first so jobs do not queue for
a dead machine:

```bash
runner_id=$(gh api repos/Kordi-Lab/Kordi/actions/runners \
  --jq '.runners[] | select(.name | endswith("-kordi-ci")) | .id')
test -n "$runner_id" && \
  gh api --method DELETE "repos/Kordi-Lab/Kordi/actions/runners/$runner_id"
```

Then remove the local service and account:

```bash
sudo launchctl bootout system/io.kordi.github-actions-runner || true
sudo rm -f /Library/LaunchDaemons/io.kordi.github-actions-runner.plist
sudo sysadminctl -deleteUser kordi-ci
sudo dscl . -delete /Groups/kordi-ci
```

Reinstall with a fresh, short-lived registration token. Never commit a runner
registration token or the generated `.credentials` files.

# Desktop Rust build artifacts

Kordi's desktop app is a Tauri/Rust target, so local development builds can create very large debug artifacts. This is mostly a developer disk/build-cost issue; release artifacts are much smaller.

Recent macOS arm64 measurements before this optimization:

| Artifact | Approx size | Notes |
| --- | ---: | --- |
| `target/debug/kordi-desktop` | 71 MiB | Debug desktop binary |
| `target/debug/deps/libkordi_desktop_lib.a` | 562 MiB | Largest debug staticlib artifact |
| `target/debug/deps/libkordi_desktop_lib.rlib` | 171 MiB | Rust library artifact |
| `target/debug/deps/libkordi_desktop_lib.dylib` | 520 KiB | Dynamic library artifact |
| `target/release/kordi-desktop` | 31 MiB | Release desktop binary |

After removing the desktop `staticlib` crate type, a fresh `cargo test -p kordi-desktop --no-default-features` does not recreate `libkordi_desktop_lib.a`; it only leaves the `rlib` and `dylib` outputs for this crate.

## What changed

`kordi-desktop` still reuses the desktop runtime surface from `kordi-cli`, but it now depends on `kordi-cli` with default features disabled:

```toml
kordi-cli = { path = "../../../agent/crates/cli", default-features = false, features = ["desktop-runtime"] }
```

The default `kordi-cli` feature set remains the full terminal CLI:

```toml
[features]
default = ["cli"]
cli = ["dep:clap", "dep:crossterm", "dep:kordi-tui"]
desktop-runtime = []
```

Shared slash-command metadata was moved to `kordi-core`, so desktop runtime code does not need the terminal UI crate just to build slash command menus.

## Dependency-surface guard

Run:

```bash
pnpm check:rust:deps
```

This checks:

```bash
cargo tree -p kordi-desktop --no-default-features
```

and fails if the desktop dependency tree contains terminal/CLI-only packages:

- `kordi-tui`
- `clap`
- `crossterm`

## Crate-type note

`app/desktop/src-tauri/Cargo.toml` now declares only the crate types used by the macOS desktop target:

```toml
[lib]
name = "kordi_desktop_lib"
crate-type = ["cdylib", "rlib"]
```

The previous `staticlib` output was the largest single debug artifact. It is common in Tauri v2 templates for mobile packaging paths, but Kordi's current Tauri target is the macOS desktop app, whose `src/main.rs` links the Rust library through the normal Rust `rlib`. If mobile targets are added later, restore `staticlib` as part of that mobile packaging work.

## Cleaning inactive worktree targets

Dry run:

```bash
pnpm clean:worktree-targets
```

Delete the listed inactive targets:

```bash
pnpm clean:worktree-targets:delete
```

The cleanup script is dry-run by default. It scans the worktree parent directory, finds `target/` directories, keeps the current repository root, and keeps any worktree root referenced by active process arguments, current working directories, or open files discovered through `ps`/`lsof`.

Useful options:

```bash
node scripts/clean-inactive-worktree-targets.mjs --worktrees-dir /Users/example/kordi-worktrees
node scripts/clean-inactive-worktree-targets.mjs --keep-root issue-216-ime-enter-composition
node scripts/clean-inactive-worktree-targets.mjs --delete --keep-root /Users/example/kordi-worktrees/main-qa
```

Use `--keep-root` for any worktree that should be protected even when there is no active process.

## Automatic debug artifact budget

Every supported Tauri debug entrypoint runs `scripts/run-with-debug-artifact-maintenance.sh` before launch and after exit. The maintenance step checks the shared `CARGO_TARGET_DIR` at most once per day unless free disk falls below the safety floor. It cleans only regenerable debug cache directories when the Cargo target exceeds 32 GiB or free disk falls below 100 GiB:

- `debug/deps`
- `debug/incremental`
- `debug/build`
- `debug/.fingerprint`

It also removes recognized `.build/ios-*`, `.build/macos-*`, and `.build/cargo*` directories older than seven days across registered Kordi worktrees. Release outputs, `.xcarchive` bundles, sources, application data, and worktree directories are never candidates. Cargo/Tauri/Kordi Desktop activity protects the Rust cache, and Xcode activity protects generated Apple build directories.

Inspect every safe candidate without deleting files:

```bash
pnpm clean:debug-artifacts
```

Run the same allowlisted cleanup immediately:

```bash
pnpm clean:debug-artifacts:delete
```

The automatic budgets can be adjusted locally without changing the repository:

```bash
export KORDI_DEBUG_ARTIFACT_MAX_GIB=32
export KORDI_DEBUG_ARTIFACT_MIN_FREE_GIB=100
export KORDI_DEBUG_ARTIFACT_STALE_DAYS=7
export KORDI_DEBUG_ARTIFACT_CHECK_HOURS=24
```

The `*:raw` desktop package commands exist only as wrapper implementation details. Do not use them for routine debugging because they bypass disk-budget maintenance.

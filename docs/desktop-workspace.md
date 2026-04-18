# Kordi Desktop Workspace

This app is the macOS desktop shell for three product layers:

- `Kordi` UI — this repository
- `bb-agent` — local agent runtime
- `Bridges` — local bridge node, daemon, and network client

## Recommended repository model

Do **not** merge all three codebases into one source-of-truth monorepo yet.

The cleaner setup is:

1. keep `bb-agent` as its own runtime repository
2. keep `Bridges` as its own network repository
3. use this repository as the desktop product repository

That gives you:

- clear ownership boundaries
- cleaner releases
- independent CI for runtime and network code
- less coupling while both backends are still evolving quickly

## Local development layout

For development, keep the three repositories as siblings:

```text
Desktop/
  Kordi/
  bb-agent/
  Bridges/
```

This repository reads those sibling locations from `kordi.workspace.json`.

## Why a fourth desktop integration repo is better than collapsing everything

If you put everything into one repo right now, you will mix:

- product UI iteration
- agent runtime internals
- network/daemon internals
- release packaging

That usually slows all three down.

The desktop app should be the integration layer, not the new home for every backend concern.

## How the macOS app should be organized

### This repository

- React frontend
- Tauri shell
- native desktop orchestration commands
- sidecar preparation script
- packaging, signing, and update flow

### bb-agent repository

- local model execution
- provider configuration
- session engine
- tools and skills

### Bridges repository

- local node identity
- local daemon
- peer networking
- project membership
- coordination client

## Current integration approach

The current Tauri setup uses **sidecar binaries**:

- `bb-agent` builds `bb`
- `Bridges` builds `bridges`
- `scripts/prepare-sidecars.mjs` builds both repos and copies the binaries into `src-tauri/binaries/`

This is the fastest route to a shippable macOS app.

## Recommended long-term architecture

After the desktop product stabilizes, extract library-facing entry points:

### bb-agent

Add a reusable service layer crate, for example:

- `bb-service`

That crate should expose:

- session operations
- model/provider execution
- streaming response hooks
- tool events

### Bridges

Split the current Rust backend into clearer crates:

- `bridges-core`
- `bridges-client`
- `bridges-daemon`
- `bridges-cli`

Then the Tauri app can link directly to Rust crates instead of supervising sidecar binaries forever.

## Recommendation

### Do now

- keep three repos
- keep this repo as the desktop app
- use sibling clones in development
- use Tauri sidecars for packaging

### Do later

- add service/library entry points to `bb-agent`
- add crate boundaries inside `Bridges`
- reduce sidecar dependence once those APIs stabilize

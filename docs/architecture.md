# Architecture

Kordi `main` contains the desktop product, hosted backend, and hosted runner/sandbox stack.

## Top-level shape

```text
kordi/
  app/desktop              # desktop product shell
  bridges/cloud-server     # Hosted API
  bridges/cloud-agent-runner # Hosted runner/sandbox
  agent                    # Agent/runtime source shared with runner/internal tooling
  shared                   # Shared protocol/type contracts
```

## Product runtime

```text
desktop app
  -> hosted API
    -> hosted database / sync events
    -> hosted agent runner
      -> hosted sandbox / model loop
```

Production API:

```text
https://coordinar.io
```

Development/QA should use `<PUBLIC_TEST_CLOUD_API_BASE>` or a self-hosted compatible server.

## Layer responsibilities

### `app/desktop`

Owns the product UI, Tauri shell, login/session restoration, chats, contacts, groups, and sync integration.

### `bridges/cloud-server`

Owns product backend behavior: accounts, auth, contacts, direct/group messages, read state, sync events, provider-auth snapshots, update manifests, and runner coordination.

### `bridges/cloud-agent-runner`

Owns hosted execution: runner polling, sandbox policy, model loop, tools, and artifact export.

### `agent`

Owns runtime internals that can be reused by hosted runner integration and internal developer workflows.

### `shared`

Owns contracts shared between Rust and TypeScript where cross-package consistency is required.

## Legacy/internal local paths

Some local runtime and Bridge-shaped adapter code remains while migration cleanup continues. These paths are not the product architecture. User-facing docs and default commands should point to the product path.

See #548 for the cleanup plan to remove or quarantine old local/P2P product surfaces.

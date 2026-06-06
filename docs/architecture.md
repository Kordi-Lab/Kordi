# Architecture

Kordi `main` is Cloud-first. The desktop app is the product surface, the hosted Cloud server is the product backend, and the Cloud agent runner provides hosted fallback/sandbox execution.

## Top-level shape

```text
kordi/
  app/desktop              # Cloud desktop product shell
  bridges/cloud-server     # Hosted Cloud API
  bridges/cloud-agent-runner # Hosted Cloud runner/sandbox
  agent                    # Agent/runtime source shared with runner/internal tooling
  shared                   # Shared protocol/type contracts
```

## Product runtime

```text
desktop app
  -> hosted Cloud API
    -> Cloud database / sync events
    -> Cloud agent runner
      -> Cloud sandbox / model loop
```

Production Cloud API:

```text
https://coordinar.io
```

Development/QA should use `<PUBLIC_TEST_CLOUD_API_BASE>` or a self-hosted compatible Cloud server.

## Layer responsibilities

### `app/desktop`

Owns the Cloud product UI, Tauri shell, login/session restoration, chats, contacts, groups, and Cloud sync integration.

### `bridges/cloud-server`

Owns product backend behavior: accounts, auth, contacts, direct/group messages, read state, sync events, provider-auth snapshots, update manifests, and runner coordination.

### `bridges/cloud-agent-runner`

Owns hosted Cloud execution: runner polling, sandbox policy, model loop, tools, and artifact export.

### `agent`

Owns runtime internals that can be reused by Cloud runner integration and internal developer workflows.

### `shared`

Owns contracts shared between Rust and TypeScript where cross-package consistency is required.

## Legacy/internal local paths

Some local runtime and Bridge-shaped adapter code remains while Cloud migration cleanup continues. These paths are not the product architecture. User-facing docs and default commands should point to the Cloud product path.

See #548 for the cleanup plan to remove or quarantine old local/P2P product surfaces.

# Architecture

Kordi `main` contains the desktop and iPhone clients, hosted backend, and hosted runner/sandbox stack.

## Top-level shape

```text
kordi/
  app/desktop              # desktop product shell
  app/ios                  # native SwiftUI iPhone client
  bridges/cloud-server     # Hosted API
  bridges/cloud-agent-runner # Hosted runner/sandbox
  agent                    # Agent/runtime source shared with runner/internal tooling
  shared/rust/protocol     # App-server protocol source of truth
```

## Product runtime

```text
desktop app / iPhone app
  -> hosted API
    -> hosted database / sync events
    -> hosted agent runner
      -> hosted sandbox / model loop
```

Production API:

```text
https://kordi.ai
```

Development/QA should follow [Development environment isolation](development-environments.md) and use the loopback Docker backend, an approved IAP-tunneled development backend, `<PUBLIC_TEST_CLOUD_API_BASE>`, or a self-hosted compatible server as selected by that preflight.

Environment choice is mandatory before a preview or debug session. Product-server-affecting operator work must be developed and first tested on the corresponding product-server machine through `https://coordinar.io`, never `https://kordi.ai`; desktop-only remote operator previews use the allowlisted `https://kordi.ai` launcher. Isolated contributor environments remain separate and cannot substitute for product-server validation. See the [required environment preflight](hosted-cloud-developer-guide.md#required-preflight-before-preview-or-debug).

## Layer responsibilities

### `app/desktop`

Owns the product UI, Tauri shell, login/session restoration, chats, contacts, groups, and sync integration.

### `app/ios`

Owns the native iPhone client: account authentication, Contact/Agent chat timelines, messages, groups, attachments, provider-auth settings, offline cache, and ordered foreground sync. It never runs an agent locally or publishes desktop-runtime presence; execution remains on a connected Mac or the hosted runner.

### `bridges/cloud-server`

Owns product backend behavior: accounts, auth, contacts, direct/group messages, read state, sync events, provider-auth snapshots, update manifests, and runner coordination.

### `bridges/cloud-agent-runner`

Owns hosted execution: runner polling, sandbox policy, model loop, tools, and artifact export.

### `agent`

Owns runtime internals that can be reused by hosted runner integration and internal developer workflows.

### `shared/rust/protocol`

Owns the app-server protocol contract. It is the single source of truth for
those Rust request and response types; do not add a hand-maintained TypeScript
mirror. The desktop Cloud client owns a separate API surface and should derive
or generate cross-language types if it ever consumes this protocol directly.

## Standalone Bridges boundary

`bridges/cli`, `bridges/registry`, and `bridges/skills/bridges` describe a
separate local/P2P network and are not dependencies of the Cloud desktop
product. They remain in the repository pending an explicit product-owner
decision about independent support or deprecation. Until that decision is
recorded:

- Cloud desktop builds must not compile, copy, sign, package, or launch the
  Bridges CLI.
- Standalone Bridges release and deployment commands must remain explicit and
  separate from the default desktop workflow.
- Hosted `bridges/cloud-server` and `bridges/cloud-agent-runner` remain core
  Cloud services; their parent directory name does not make them legacy.
- `bridges/cloud-temporal-bridge` remains an infrastructure adapter pending
  deployment-owner verification and must not be renamed or removed as part of
  desktop cleanup.

See [Cloud and standalone Bridges boundary](architecture/bridges-boundary.md)
for component ownership, disposition, and stored-ID compatibility rules.

## Legacy/internal local paths

Historical Bridge-shaped identifiers remain only at documented storage and wire
compatibility boundaries, and the standalone runtime remains under
`bridges/`. The Cloud desktop has no local Bridges runtime or adapter. These
compatibility and standalone paths are not the Cloud product architecture;
user-facing docs and default commands must point to the hosted product path.

See #548 for the cleanup plan to remove or quarantine old local/P2P product surfaces.

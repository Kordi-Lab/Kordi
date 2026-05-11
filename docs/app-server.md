# App Server Design

This document defines the first app-facing backend shape for Kordi.

The immediate goal is not to replace the agent runtime or Bridges. The goal is
to add one stable product backend that both the desktop frontend and the TUI can
talk to without each client re-implementing runtime, session, and network
orchestration.

## Current state

What we have today:

- `agent` owns the real local runtime, session store, and TUI execution flow.
- `bridges` owns the real network and project coordination behavior.
- `app/desktop` now uses real runtime-backed chat, project, auth, and bridge integrations through the desktop/Tauri layer.
- `shared/*/protocol` is available for app-facing contracts shared across Rust and TypeScript.

Runtime check performed for this design pass:

- `cargo check -p kordi-cli`: passes
- `kordi --help`: works
- `cargo test --workspace`: still blocked by known test fixture drift in
  `agent/crates/session/src/compaction/tests.rs`

That means the agent runtime is buildable enough to serve as the local engine,
but we do not yet have an app-facing product API.

## Target topology

```text
desktop react app ----\
                        -> app-server -> agent runtime
tui client -----------/               -> bridges local API / daemon
                                      -> local workspace + sidecar state
```

The app server is the app-facing backend that product clients can converge on over time.
It owns orchestration, not model/provider internals and not network transport
internals.

## Why a separate app server

This split keeps responsibilities clean:

- `agent` remains the source of truth for turns, tools, session trees, and local
  persistence.
- `bridges` remains the source of truth for peer discovery, projects, routing,
  and delivery state.
- `app-server` turns those lower-level systems into one product contract for UI
  clients.
- `app/desktop` stays focused on UX and process lifecycle instead of becoming a
  backend.

This also gives the TUI a path to consume the same contract when that helps,
without forcing the TUI to become a web app.

## Server ownership

The new app server should live in a dedicated app-facing Rust crate, preferably
under `app/server` or another app-layer location rather than inside `app/desktop`
or `bridges`.

It should own:

- local service lifecycle for agent + bridges sidecars
- bootstrap state for clients
- session list/detail queries
- turn submission and streaming
- tool approval handoff
- project and peer read models derived from Bridges
- composition of runtime state and network state into one UI contract

It should not own:

- provider-specific model logic
- raw session storage schemas
- direct peer transport semantics
- registry data schemas

## Client model

There are two first-class clients:

1. Desktop frontend
2. TUI

The desktop frontend should use the app server over HTTP + SSE.

The TUI has two valid modes:

- preferred long-term: use the same protocol through an in-process or loopback
  client adapter
- short-term migration: keep its current direct runtime wiring, but start
  consuming shared protocol DTOs for session, timeline, and event views

This means the protocol must be UI-oriented and stable, but still thin enough
that the TUI is not forced to adopt web-only concepts.

## Transport design

Use two transport lanes:

- request/response: HTTP JSON
- streaming updates: SSE

Why SSE first:

- simple to debug over loopback
- natural fit for streaming turn output and state updates
- easier than WebSocket for this phase because most updates are server-to-client

Recommended endpoint shape:

- `GET /v1/bootstrap`
- `GET /v1/sessions`
- `POST /v1/sessions`
- `GET /v1/sessions/:session_id`
- `GET /v1/sessions/:session_id/forks`
- `POST /v1/sessions/:session_id/forks`
- `POST /v1/sessions/:session_id/turns`
- `POST /v1/approvals/:approval_id`
- `GET /v1/projects`
- `GET /v1/peers`
- `GET /v1/events`
- `GET /v1/sessions/:session_id/events`

## Protocol design

The shared protocol should stay app-facing, not storage-facing.

That means:

- expose `SessionSummary`, not raw SQLite rows
- expose `TimelineEntry`, not raw agent/session entry variants
- expose `ServiceSnapshot`, not direct daemon structs
- expose `ProjectSummary` and `PeerSummary`, not raw coordination records

The initial protocol in `shared/rust/protocol` and
`shared/typescript/protocol` now covers:

- bootstrap metadata
- service health snapshots
- session/project/peer summaries
- session detail timelines
- turn submission
- approval requests
- streamed session events

## Mapping to current code

The existing codebase already gives us most of the internals we need:

- `agent/crates/session` provides persisted sessions and active-path reads
- `agent/crates/core/src/agent_session_runtime` already models runtime messages,
  usage, compaction, retry, and session-tree events
- `bridges/cli/src/local_api.rs` already exposes app-adjacent project and peer
  actions, but at the subsystem level rather than as a full product backend

The app server should adapt these existing primitives instead of inventing a new
state model.

## Implementation phases

### Phase 1: contract and bootstrap

- add shared protocol DTOs
- implement `GET /v1/bootstrap`
- report runtime and bridges health
- expose session/project/peer summaries

### Phase 2: session detail and turns

- implement `GET /v1/sessions/:id`
- implement `GET /v1/sessions/:id/forks`
- implement `POST /v1/sessions/:id/forks`
- implement `POST /v1/sessions/:id/turns`
- stream assistant output and runtime state over SSE
- surface tool approval requests as protocol events

### Phase 3: desktop migration

- replace `app/desktop/src/kordi-app/data.tsx` mock data with an app-server client
- keep Tauri focused on process lifecycle and local permissions

### Phase 4: TUI convergence

- move session list/detail rendering toward shared protocol DTOs
- optionally let the TUI connect to the app server through a local adapter
- keep terminal-native interaction while sharing the same app model

## Design rules

- One app-facing server, not one per client.
- Frontend clients do not call Bridges or raw runtime internals directly.
- Tauri is not the backend.
- Shared protocol types live only in `shared/*/protocol`.
- Runtime/storage internals can evolve as long as the app protocol remains
  stable.

# Bridges Core Architecture

This document is the canonical architecture overview for the Bridges core network component.

It explains how the current Bridges implementation fits together as:
- a local CLI
- a local daemon and runtime bridge
- a coordination server
- an encrypted transport layer with direct and relay paths
- a project-scoped trust and collaboration system
- an optional shared-workspace sync layer
- an adjacent registry service

This is a core-network architecture document, not a website or dashboard product spec.

## 1. System purpose and scope

Bridges is a human-agent and agent-agent collaboration infrastructure.

In this repo, that means the core is organized around a few concrete jobs:
- establish and persist a local node identity
- register that node with a coordination server
- create and join shared projects
- discover authorized peers, keys, and endpoint hints within project boundaries
- send encrypted collaboration traffic between peers
- bridge inbound network messages into a local agent runtime
- expose local operational status and diagnostics
- optionally keep a shared project workspace synchronized

The main architectural surfaces in this repo are:
- `cli/` — Rust CLI, daemon, local API, transport, coordination client, and coordination server
- `registry/` — standalone TypeScript registry service
- `skills/bridges/` — runtime/operator integration instructions and helper tools

This document does **not** describe:
- a website/dashboard architecture
- a multi-tenant SaaS account model
- a browser-first product surface
- guarantees that Bridges does not currently implement

For lower-level contracts, see:
- `docs/privacy-model.md`
- `docs/delivery-semantics.md`
- `docs/presence-model.md`
- `docs/permissions-model.md`
- `docs/addressing-model.md`
- `docs/identity-lifecycle.md`

## 2. Core actors and trust domains

Bridges has several distinct actors with different responsibilities and visibility.

### Local human/operator
The human installs Bridges, configures the coordination URL, chooses a runtime, creates or joins projects, and manages lifecycle operations such as rotation or revocation.

The operator is trusted to control the local machine and local runtime configuration.

### Local agent runtime
This is the runtime that actually answers prompts or handles inbound collaboration work, such as Claude Code, Codex, Pi Agent, OpenClaw, or a generic HTTP runtime.

The runtime is trusted with plaintext collaboration content that the local daemon delivers to it.

The runtime is **not** the source of truth for network identity, project membership, or routing.

### Local Bridges CLI
The CLI is the operator-facing entry point.

It is responsible for:
- setup and registration
- project and invite workflows
- local identity lifecycle commands
- diagnostics and status
- sending commands to the local daemon API

The CLI owns user interaction and local configuration workflows, but it is not the long-running network endpoint.

### Local Bridges daemon
The daemon is the persistent local network agent.

It is responsible for:
- transport setup
- endpoint publication
- DERP and mailbox interaction
- inbound message handling
- runtime dispatch
- local presence tracking
- serving the local daemon API

The daemon is the main runtime bridge between the local runtime and the Bridges network.

### Coordination server
The coordination server is the control-plane authority for:
- node registration and API-key auth
- projects, memberships, and invites
- key lookup and endpoint lookup
- relay/mailbox durability
- lifecycle operations such as revoke and replace

The coordination server can see routing and membership metadata required to operate the network.

It should not need plaintext collaboration content.

### Peer nodes
Peer nodes are other Bridges participants.

A peer can learn project-scoped metadata when it shares a project with the local node, including keys, member metadata, roles, and endpoint hints, subject to the project visibility rules.

### Optional registry service
The registry is a separate TypeScript service in `registry/`.

It is an adjacent service for registry-style node/project/skill workflows, not the core authority for Bridges transport sessions, daemon health, or local runtime dispatch.

## 3. What each trust domain sees

### Private keys
Private keys remain local to the node.

The coordination server does not store private keys.

### Plaintext collaboration content
Plaintext collaboration content is visible to:
- the local sender before encryption
- the local recipient after decryption
- the local runtime that handles inbound work

Plaintext content is not intended to be readable by the coordination server.

### Routing metadata
Routing metadata is visible to the coordination server as needed for:
- registration
- project membership enforcement
- key lookup
- endpoint lookup
- DERP relay
- mailbox routing and retention

### Membership metadata
Project membership metadata is visible to the coordination server and to authorized project members.

Bridges is currently **content-private, not metadata-private**.

## 4. Core components and responsibilities

### CLI
The CLI is responsible for operator workflows.

It owns:
- command parsing
- setup and guided onboarding
- local config writes
- local identity commands
- high-level project/invite/member commands
- status and doctor output

It exposes:
- the `bridges` command-line surface

It does **not** own:
- long-lived transport state
- peer sessions
- runtime dispatch loops
- control-plane persistence on the server

### Local daemon
The daemon is the long-running local process.

It owns:
- transport state
- peer/session cache state
- local API server state
- mailbox polling behavior
- runtime dispatch behavior
- local presence observations

It exposes:
- the local API on `http://127.0.0.1:<port>`

It does **not** own:
- authoritative project membership
- durable server-side identity state
- registry state

### Local API
The local API is the CLI-to-daemon boundary.

It owns request handling for:
- `ask`
- `broadcast`
- `debate`
- `publish`
- pending local response tracking
- peer/status inspection

It exposes structured local routes such as:
- `POST /ask`
- `POST /broadcast`
- `POST /debate`
- `POST /publish`
- `GET /response/:id`
- `GET /peers`
- `GET /status`

It does **not** define global control-plane truth. It reflects local daemon state plus coordination lookups.

### Runtime bridge / listener
The runtime bridge is the inbound dispatch layer that turns Bridges messages into runtime-specific work.

It owns:
- runtime adapter selection
- runtime request formatting
- sandbox/context construction for inbound messages
- optional conversation-memory append behavior

It does **not** own:
- project membership policy
- transport routing decisions
- lifecycle enforcement

### Transport layer
The transport layer is responsible for encrypted peer-to-peer or relay-assisted delivery.

It owns:
- direct session establishment
- packet encryption/decryption
- peer connection/session state
- source identity binding checks
- fallback to relay/mailbox when needed

It does **not** own:
- project creation
- invite semantics
- role/capability policy

### Coordination server
The coordination server is the authoritative control-plane service.

It owns durable state for:
- registered nodes
- projects
- memberships
- invites
- endpoint hints
- mailbox relay entries
- lifecycle state for revocation/replacement

It exposes HTTP APIs for:
- registration/auth
- projects and invites
- key and endpoint lookup
- relay/mailbox flows
- lifecycle operations

It does **not** execute the local runtime or own local daemon presence.

### Optional shared-workspace sync
Shared-workspace sync is an optional collaboration helper.

It owns:
- local `.shared/` synchronization behavior when explicitly used
- lazy local git repo initialization for shared workspace content

It does **not** define the core Bridges messaging or trust model.

### Registry service
The registry service is a separate TypeScript service.

It owns its own schema, routes, and auth model for registry workflows.

It does **not** replace the Rust coordination daemon as the core runtime bridge / transport authority.

### Skills
The skill files are the integration layer for external runtimes.

They own:
- runtime-facing instructions
- tool wrappers
- operator guidance

They do **not** own network authority, membership truth, or transport state.

## 5. Control plane vs data plane vs local collaboration plane

Bridges is easier to understand when split into three planes.

### Control plane
The control plane manages identity, trust, and routing metadata.

Current control-plane responsibilities include:
- node registration
- node API-key authentication
- project creation
- invite creation and join
- membership lookup
- project-scoped key lookup
- project-scoped endpoint lookup
- identity revoke / replace operations

The main control-plane authority is `bridges serve`.

### Data plane
The data plane carries encrypted collaboration traffic.

Current data-plane responsibilities include:
- direct encrypted transport
- DERP relay transport
- mailbox relay fallback
- ask/broadcast/debate/publish payload delivery
- peer session establishment and rekeying

The daemon and transport stack are the main data-plane components.

### Local collaboration plane
The local collaboration plane is the daemon-local operational and workflow layer.

It includes:
- local daemon API state
- pending request/response state
- local session history and conversation memory
- local peer observations (`/peers`)
- local status/doctor output
- optional shared workspace state

This plane is local and operational. It is not a globally authoritative distributed state system.

## 6. Identity and trust model

Bridges node identity is derived from the local Ed25519 key.

That means:
- node IDs are not arbitrary labels
- a real Ed25519 key change implies a new `kd_...` node ID
- transport uses corresponding X25519 material

Current identity layers are:
- **Ed25519 identity key** — local identity root
- **derived node ID** — stable identifier for that keypair
- **X25519 transport key** — used for transport encryption and verification
- **node API key** — coordination-auth credential issued at registration

### Current lifecycle model
Bridges V1 implements rotation as **replacement + revocation**.

That means:
- a replacement node registers normally
- the old node requests replacement
- project memberships migrate to the new node
- the old node is revoked
- revoked nodes stop authenticating and stop appearing in normal key/endpoint lookup

### Current trust enforcement
The current implementation enforces several identity invariants:
- registration derives node ID from the submitted Ed25519 public key
- X25519 material must match the Ed25519 keypair
- direct transport packets are bound back to real node identities
- responder-side handshakes verify cached coordination-resolved peer keys
- project-scoped transport caches are refreshed and stale peers are pruned
- send paths refresh peer visibility before use

### V1 limitations
Bridges intentionally does **not** currently promise:
- seamless in-flight session continuity after replacement
- mailbox migration from old node to replacement node
- preserving the old node ID after a key change

See `docs/identity-lifecycle.md` for the detailed lifecycle contract.

## 7. Project, authorization, and addressing model

Projects are the primary collaboration and visibility boundary in Bridges.

A project determines:
- who can see other members
- who can fetch peer keys/endpoints
- who can send project-scoped collaboration actions
- how human-friendly selectors are resolved

### Roles and capabilities
Bridges currently defines:
- `owner`
- `member`
- `guest`

These roles map onto concrete capabilities such as:
- `view_members`
- `ask`
- `debate`
- `broadcast`
- `publish`
- `sync`
- `manage_invites`
- `admin`

Enforcement happens at both layers:
- coordination routes enforce invite/member visibility rules
- local daemon API handlers enforce allowed project-scoped actions before sending

See `docs/permissions-model.md` for the role/capability contract.

### Addressing model
Bridges supports both exact and human-friendly addressing.

Current selectors include:
- raw `kd_...` node IDs
- project display names
- `owner`
- `role:<role>`

Non-node selectors are project-scoped and intentionally reject ambiguity.

See `docs/addressing-model.md` for the exact selector rules.

## 8. Message and transport flows

The main collaboration flows are:
- `ask`
- `broadcast`
- `debate`
- `publish`

All of them follow the same high-level path:

1. operator or skill invokes the CLI
2. CLI sends a request to the local daemon API
3. local daemon resolves project membership/keys as needed
4. daemon attempts direct encrypted transport first
5. if direct delivery is unavailable, daemon falls back to coordination relay/mailbox
6. peer daemon receives and validates the message
7. peer daemon dispatches the message to the configured runtime
8. for response-style flows, the response returns through Bridges and is matched locally

### `ask`
`ask` is single-target request/response.

The local daemon allocates a `requestId`, attempts delivery, and tracks the pending response locally.

### `broadcast`
`broadcast` is fanout fire-and-forget to project peers.

### `debate`
`debate` is fanout request/response to project peers, with one request ID per successfully delivered peer.

### `publish`
`publish` is fanout artifact delivery, carrying a filename plus base64 artifact data.

### Direct-first behavior
The daemon prefers direct delivery when possible.

If the current session is missing or needs rekeying, it attempts handshake establishment before send.

### Relay behavior
If direct delivery fails, Bridges falls back to the coordination path:
- DERP relay when live relay routing is available
- durable mailbox relay when necessary

Mailbox relay preserves queued entries until fetch, then drains them.

### Important semantic boundary
Delivery success means the message was handed to a valid transport or relay path.

It does **not** mean the remote runtime has already processed the message.

See `docs/delivery-semantics.md` for the exact success and partial-failure contract.

## 9. Presence, diagnostics, and operations

Bridges separates local process presence, component health, and reachability.

### Daemon presence
The first question is whether the local daemon is up and answering its local API.

### Component health
The daemon separately tracks whether:
- coordination interactions are succeeding
- runtime dispatch is succeeding

### Reachability mode
The daemon separately tracks whether the node currently appears:
- direct-capable
- relay-only
- unknown

### Peer observations
`GET /peers` exposes local transient peer transport observations such as:
- connection path
- session state
- last inbound activity
- last outbound activity

These are local observations, not distributed truth.

### Operational commands
The main operator-facing commands are:
- `bridges setup --guided`
- `bridges service status`
- `bridges status`
- `bridges doctor`
- `bridges identity status`
- `bridges identity rotate`
- `bridges identity revoke`

### Service vs foreground operation
Bridges supports both:
- service-managed background daemon operation
- direct foreground daemon execution

The service layer exists for operator convenience; it is not a separate network role.

See `docs/presence-model.md` for the structured status model.

## 10. Privacy and metadata boundaries

Bridges is currently **content-private, not metadata-private**.

### Content privacy
Encrypted collaboration payloads are intended to remain opaque to the coordination server.

### Coordination-visible metadata
The coordination server is still allowed to see metadata required for operation, including:
- node registration metadata
- project and membership metadata
- sender/receiver routing metadata
- endpoint hints
- mailbox timing and blob-size characteristics

### Peer-visible metadata
Project membership is the main visibility boundary.

Within a shared project, peers may learn other members':
- node IDs
- display names
- roles
- public keys
- endpoint hints

Outside a shared project, arbitrary peer discovery should not be available.

### Retention
Current retention is split between:
- durable control-plane state such as registrations, projects, memberships, invites, and endpoint hints
- durable mailbox rows until fetched
- transient in-process DERP routing state
- transient local daemon observations such as peer activity timestamps

See `docs/privacy-model.md` for the detailed privacy and retention contract.

## 11. Optional shared-workspace sync and registry placement

These features are part of the repo, but they are not the architectural center of Bridges.

### Shared-workspace sync
Shared-workspace sync is optional.

It is useful when collaborators want to exchange `.shared/` workspace content, but Bridges core messaging does not depend on it.

Projects can exist and messages can flow without using sync at all.

### Registry service
The TypeScript registry service is also optional and adjacent.

It should be treated as a separate service with its own routes and schema, not as the heart of the Rust coordination/daemon/transport architecture.

### Skills
Skills are also optional integration assets.

They make Bridges easier to drive from external runtimes, but they are wrappers around the core system rather than the source of network truth.

## 12. Failure model and non-goals

Bridges currently chooses explicit, limited guarantees over vague promises.

It does **not** currently promise:
- exactly-once delivery
- end-to-end acknowledgement of runtime processing for every flow
- global metadata privacy from the coordination operator
- strong distributed truth about whether a peer is globally online
- seamless session/mailbox migration during identity replacement
- website-first product assumptions or user-account-centric flows

Bridges is therefore best understood as:
- a practical encrypted collaboration network
- with explicit control-plane authority
- best-effort encrypted delivery semantics
- project-scoped trust boundaries
- strong local operator/runtime integration
- intentionally modest global guarantees

## 13. Contributor code map

Use this map to connect the architecture above to the current implementation.

### CLI and operator workflows
- `cli/src/main.rs` — CLI entry point, command definitions, top-level command wiring
- `cli/src/commands.rs` — operator workflows, HTTP client calls, setup, doctor, identity, invite/join, selector resolution

### Local daemon and local API
- `cli/src/daemon.rs` — daemon startup, coordination polling, runtime dispatch loop, transport identity refresh, mailbox handling
- `cli/src/local_api.rs` — daemon-local HTTP API for ask/broadcast/debate/publish/status/peers

### Transport and session state
- `cli/src/transport.rs` — direct/relay send and receive behavior, packet-source identity binding, handshake integration
- `cli/src/connmgr.rs` — peer connection/session cache, reachability/session state, identity retention/pruning
- `cli/src/noise.rs` — Noise handshake/session helpers
- `cli/src/crypto.rs` — key conversion, packet/message encryption helpers
- `cli/src/derp_client.rs` — DERP relay client behavior
- `cli/src/mdns.rs` / `cli/src/stun.rs` — local discovery and reachability support

### Coordination client and control plane
- `cli/src/coord_client.rs` — client for coordination server routes
- `cli/src/serve/mod.rs` — coordination server router and schema setup
- `cli/src/serve/auth.rs` — registration, API-key auth, lifecycle status/revoke/replace
- `cli/src/serve/projects.rs` — project creation, listing, member listing
- `cli/src/serve/invites.rs` — invite creation, listing, join behavior
- `cli/src/serve/keys.rs` — project-scoped key lookup
- `cli/src/serve/endpoints.rs` — project-scoped endpoint lookup/publication
- `cli/src/serve/relay.rs` — relay, mailbox, and durable mailbox state
- `cli/src/serve/skills.rs` — server-side skill route behavior

### Presence, permissions, and local state models
- `cli/src/presence.rs` — daemon/component/reachability status model
- `cli/src/permissions.rs` — role/capability table and enforcement helpers
- `cli/src/client_config.rs` — local client config persistence
- `cli/src/config.rs` — daemon config persistence
- `cli/src/identity.rs` — local identity generation/loading/replacement
- `cli/src/db.rs`, `cli/src/models.rs`, `cli/src/queries.rs` — local SQLite state and project/workspace metadata
- `cli/src/conversation_memory.rs` — local conversation/session memory support

### Runtime bridge and optional sync
- `cli/src/listener/dispatch.rs` and `cli/src/listener/runtimes.rs` — runtime adapter creation and dispatch behavior
- `cli/src/sync_engine.rs` — optional shared-workspace sync behavior
- `cli/src/workspace.rs` — local workspace initialization and metadata

### Registry and runtime integration assets
- `registry/src/*` — standalone registry service implementation
- `skills/bridges/*` — runtime-facing skill instructions, helpers, and templates

## 14. Relationship to the contract docs

This document is the high-level architecture view.

The lower-level contract docs remain the source for their specific topics:
- `docs/privacy-model.md` — visibility and retention boundaries
- `docs/delivery-semantics.md` — send/result semantics and non-guarantees
- `docs/presence-model.md` — daemon/runtime/reachability status model
- `docs/permissions-model.md` — role/capability contract
- `docs/addressing-model.md` — human-friendly selector rules
- `docs/identity-lifecycle.md` — replacement/revocation model

Contributors should update both this architecture doc and the relevant contract doc whenever they change a core cross-cutting behavior.

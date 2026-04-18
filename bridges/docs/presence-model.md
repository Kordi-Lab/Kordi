# Bridges Presence + Reachability Model

This document defines the current Bridges model for node presence, liveness, and reachability.

The goal is to separate three different questions that were previously mixed together:

1. **Is the local daemon up?**
2. **Can the daemon currently talk to coordination and the configured runtime?**
3. **How is the node likely reachable by peers: direct, relay-only, or unknown?**

Bridges currently exposes this model through:
- the local daemon API `GET /status`
- the local daemon API `GET /peers`
- `bridges status`

## 1. Top-level model

Bridges tracks presence at three layers:

### A. Daemon presence
This answers whether the local Bridges daemon is currently online.

Current contract:
- **online**: the local API responds on `http://<LOCAL_BRIDGES_HOST>:<PORT>/status`
- **offline**: the local API cannot be reached or returns a non-success status

This is a local-process fact, not a network-wide fact.

### B. Component health
This answers whether the online daemon is currently succeeding at its two key dependencies.

Current components:
- **coordination**
- **runtime**

Each component reports one of:
- `healthy`
- `degraded`
- `unknown`

Current semantics:
- **coordination = healthy** after a successful coordination operation such as endpoint publication, DERP connection, or mailbox poll
- **coordination = degraded** after a failed coordination operation such as mailbox polling or DERP connection
- **coordination = unknown** before any successful or failed coordination operation has been recorded in this daemon lifetime
- **runtime = healthy** after a successful inbound runtime dispatch
- **runtime = degraded** after an inbound runtime dispatch error
- **runtime = unknown** before any inbound runtime dispatch has been attempted in this daemon lifetime

These are daemon-lifetime observations, not durable distributed truth.

### C. Reachability mode
This answers how the node is currently expected to receive traffic.

Current modes:
- `direct_and_relay`
- `direct_only`
- `relay_only`
- `unknown`

Current semantics:
- **direct_and_relay**: endpoint hints were published and DERP is connected
- **direct_only**: endpoint hints were published and DERP is not connected
- **relay_only**: no endpoint hints are published, but DERP is connected
- **unknown**: neither endpoint hints nor DERP connectivity are currently established

Mailbox fallback is considered available and durable when the coordination server is reachable, but it is still best-effort at the application layer; see `docs/delivery-semantics.md`.

## 2. Local API contract

## `GET /status`

`GET /status` returns a structured view of local daemon presence:
- `node_id`
- `healthy`
- `daemon`
- `coordination`
- `runtime`
- `reachability`

Current `healthy` rule:
- `healthy=true` when the daemon is online and neither `coordination` nor `runtime` is currently `degraded`
- `healthy=false` when either component is `degraded`

This is intentionally stricter than just “the process is running.”

## `GET /peers`

`GET /peers` returns transient peer-connection observations from the local transport layer.

Each peer entry currently includes:
- `peer_id`
- `connection_state`
- `reachability`
- `session_state`
- `last_inbound_at`
- `last_outbound_at`

Current peer reachability values:
- `lan`
- `direct`
- `relay_only`
- `probing`
- `unknown`

These are **local transport observations only**. They are not globally coordinated presence status.

## 3. Last-seen semantics

Bridges currently distinguishes between:
- **local transient activity timestamps** on active peer transport state
- **legacy local database fields** like `peers.last_seen_at`

Current authoritative behavior for presence work:
- `GET /peers.last_inbound_at` = last time this daemon successfully received a transport packet from that peer during the current daemon lifetime
- `GET /peers.last_outbound_at` = last time this daemon successfully sent a transport or handshake packet to that peer during the current daemon lifetime

Important non-guarantees:
- these timestamps are **not durable** across daemon restart
- they do **not** imply remote runtime health
- they do **not** imply project membership or authorization on their own
- they do **not** imply the message was processed by the remote runtime

The older `peers.last_seen_at` database field should be treated as legacy/local metadata, not the authoritative presence contract for current core behavior.

## 4. What presence does and does not mean

### What Bridges presence can currently say
- whether the local daemon is online
- whether coordination interactions are currently succeeding or failing
- whether inbound runtime dispatches are currently succeeding or failing
- whether local transport currently looks direct-capable, relay-only, or unknown
- whether a specific local peer transport entry has recent inbound/outbound activity

### What Bridges presence cannot currently say
- whether another node is globally “online” in a strong distributed sense
- whether a peer runtime is idle, busy, or ready before sending a message
- whether a peer has processed a previously delivered message
- whether a peer is directly reachable from every other network location
- whether an empty mailbox means a peer is offline, idle, or simply has no pending messages

## 5. CLI contract

`bridges status` should present:
- static identity and registration info
- local daemon presence (`online` / `offline`)
- coordination health
- runtime health
- reachability mode
- local project list

If the daemon cannot be reached, the CLI should say the daemon is offline rather than pretending the whole node is healthy.

## 6. Contributor guidance

When implementing future presence-related work:
- do not collapse daemon-online, runtime-health, and transport-reachability into one boolean
- do not treat mailbox emptiness as proof of peer offline status
- do not treat direct reachability hints as proof of runtime readiness
- prefer explicit structured states over inferred prose strings
- preserve the distinction between **local observation** and **network-wide truth**

## 7. Future extensions

This model is intentionally minimal for Phase 1.

Follow-up work can build on it by adding:
- explicit coordination heartbeats / leases
- peer liveness TTLs
- runtime health probes for HTTP-based runtimes
- richer DERP/mailbox diagnostics
- project-scoped presence views
- doctor/diagnostic commands

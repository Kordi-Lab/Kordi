# Bridges Privacy Model

Bridges is **content-private, not metadata-private**.

That means:
- private keys stay local
- encrypted message bodies are intended to be opaque to the coordination server
- the coordination server still sees the metadata it needs to authenticate nodes, manage projects, and route traffic
- Bridges does **not** currently try to hide project membership, sender/receiver relationships, or endpoint reachability from the coordination operator

This document describes the current privacy contract for the Bridges core network component.

## 1. Coordination-visible metadata

The coordination service is currently allowed to see and store the following.

### Node registration metadata
- `node_id`
- Ed25519 public key
- X25519 public key
- optional display name / owner name
- API key hash
- endpoint hints
- node creation timestamp

### Project and membership metadata
- project IDs and slugs
- project creator node
- current member list
- member role
- join timestamps
- invite IDs, creators, max-use values, and use counters

### Routing metadata
For direct/relay routing, the coordination service may observe:
- source node ID
- destination node ID
- timing of sends/fetches
- rough payload size characteristics
- endpoint / reachability hints published by nodes

### What the coordination service should not need
The coordination service should not need plaintext message content to operate the network.

## 2. Peer-visible metadata

The default visibility boundary is **shared project membership**.

Within a shared project, a node may currently learn:
- other member node IDs
- display names
- Ed25519/X25519 public keys
- member roles
- join timestamps
- endpoint hints

Outside a shared project, peers should not be able to discover arbitrary node keys, endpoint hints, or membership data.

## 3. Delivery-path privacy

### Direct transport
Direct transport keeps message content encrypted end-to-end, but it does not hide that two nodes are communicating.

### DERP relay
DERP relay keeps payload content encrypted, but the coordination operator can still observe:
- source node ID
- destination node ID
- timing
- traffic size characteristics

DERP is therefore **not metadata-private** against the coordination operator.

### Mailbox relay fallback
Mailbox fallback keeps payload content encrypted, but the coordination service still observes and stores:
- sender node ID
- target node ID
- queued-at timestamp
- encrypted blob size characteristics

To reduce extra metadata exposure, mailbox entries should avoid retaining project IDs unless they are strictly required for routing or authorization.

## 4. Retention

### Durable by default
The following coordination metadata is currently durable unless explicitly changed or removed:
- node registration metadata
- project metadata
- membership metadata
- invite metadata and use counters
- endpoint hints

### Mailbox retention
Mailbox entries are durable **until fetched successfully**, then deleted.

Bridges does not currently promise long-term mailbox history retention, but it also does not promise metadata minimization beyond deleting drained mailbox rows.

### DERP runtime state
Live DERP routing state is intended to be transient in-process state rather than durable message history.

## 5. Guarantees and non-guarantees

### Guarantees
- private keys do not leave the local machine
- direct transport payloads are encrypted end-to-end
- mailbox payload bodies are encrypted end-to-end
- plaintext collaboration content is not intended to be readable by the coordination server

### Non-guarantees
Bridges does **not** currently guarantee:
- metadata privacy from the coordination operator
- hidden project membership from the coordination operator
- hidden sender/receiver relationships for DERP or mailbox routing
- hidden endpoint/reachability information once endpoint hints are published
- anonymous communication, unlinkability, or cover traffic
- automatic deletion/minimization of most coordination metadata beyond mailbox-drain behavior

## 6. Implementation expectations

Code and tests should enforce the following boundaries:
- key lookup is project-scoped
- endpoint lookup is project-scoped
- member lists are project-scoped
- mailbox entries are deleted after successful fetch
- relay/mailbox metadata is minimized where possible without breaking routing/auth

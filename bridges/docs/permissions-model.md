# Bridges Permissions Model

This document defines the current Bridges role and capability model.

## Role in Kordi

Use this document when you need the authorization contract for the Kordi Bridges layer.

It is the reference for:

- project roles
- capability mapping
- enforcement points
- contributor rules for new actions

Bridges separates:
- **membership** — whether a node belongs to a project
- **role** — the node's position inside that project
- **capability** — which actions that role is allowed to perform

## 1. Roles

Bridges currently defines three project roles:

- `owner`
- `member`
- `guest`

### `owner`
The project owner is the administrative role.

Current owner abilities:
- do all normal collaboration actions
- create and list invites
- perform project-admin actions

### `member`
A normal collaborating project node.

Current member abilities:
- list members
- send `ask`
- send `debate`
- send `broadcast`
- send `publish`
- use optional shared-workspace `sync`

Current non-abilities:
- cannot manage invites
- cannot perform admin-only actions

### `guest`
A limited-participation project node.

Current guest abilities:
- list members
- send `ask`

Current non-abilities:
- cannot `debate`
- cannot `broadcast`
- cannot `publish`
- cannot manage invites
- cannot perform admin-only actions

## 2. Capability table

| Capability | owner | member | guest |
| --- | --- | --- | --- |
| `view_members` | ✅ | ✅ | ✅ |
| `ask` | ✅ | ✅ | ✅ |
| `debate` | ✅ | ✅ | ❌ |
| `broadcast` | ✅ | ✅ | ❌ |
| `publish` | ✅ | ✅ | ❌ |
| `sync` | ✅ | ✅ | ❌ |
| `manage_invites` | ✅ | ❌ | ❌ |
| `admin` | ✅ | ❌ | ❌ |

## 3. Current enforcement points

The current core now enforces this model in the following places:

### Coordination server
- project creators are inserted as `owner`
- invite creation/listing requires `manage_invites` (currently owner-only)
- invite joins may request only `member` or `guest`; `owner` escalation is rejected
- member listing returns each member's derived capability set

### Local daemon API
For project-scoped messaging:
- `ask` requires `ask`
- `debate` requires `debate`
- `broadcast` requires `broadcast`
- `publish` requires `publish`

The local daemon derives the sender's role from current project membership returned by coordination.

## 4. Why this model exists

This model gives Bridges a concrete answer to “what may a project participant do?” without requiring a full custom ACL system yet.

It is intentionally:
- simple enough to implement consistently in Phase 1
- explicit enough for CLI/API contributors to code against
- narrow enough to keep the core focused on collaboration/network behavior

## 5. What this model does not yet provide

Bridges does **not** yet provide:
- custom per-project arbitrary ACL editing
- per-node capability grants outside the built-in role table
- per-path sync permissions
- per-conversation or per-message exceptions
- human approval workflows on top of the role model

Those can be layered later, but new work should treat the role/capability table above as the current contract.

## 6. Contributor rules

When adding new project actions:
- define the required capability explicitly
- map that capability onto the built-in roles
- reject role escalation at invite/join boundaries
- prefer role-derived capabilities over ad-hoc `if owner` checks scattered through the code

## 7. Relationship to other docs

- `docs/privacy-model.md` explains who can see membership metadata
- `docs/presence-model.md` explains status / reachability signals
- `docs/delivery-semantics.md` explains what successful delivery means once an action is authorized

## Related docs

- [README.md](README.md)
- [core-architecture.md](core-architecture.md)
- [privacy-model.md](privacy-model.md)
- [presence-model.md](presence-model.md)
- [delivery-semantics.md](delivery-semantics.md)

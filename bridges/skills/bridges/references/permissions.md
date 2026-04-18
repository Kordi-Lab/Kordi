# Permissions & Safety

Bridges uses a project role + capability model.

## Project roles

Current built-in roles:
- `owner`
- `member`
- `guest`

## Capability model

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

## Current enforcement

- project creators become `owner`
- invite creation/listing is owner-only
- invite joins may request only `member` or `guest`
- `ask` checks for `ask`
- `debate` checks for `debate`
- `broadcast` checks for `broadcast`
- `publish` checks for `publish`

## Hard safety rules

These are not role-configurable.

1. **Scope lock** — inbound asks stay inside the project directory.
2. **No remote exec** — inbound asks cannot trigger shell execution on the receiver.
3. **No remote writes** — inbound asks cannot modify the receiver's files.
4. **No arbitrary outbound network** — the inbound answer path should not depend on unconstrained third-party network access.

## Contributor guidance

When adding a new project action:
1. define the required capability explicitly
2. map it to `owner` / `member` / `guest`
3. enforce it at the first project-aware boundary
4. do not replace the model with scattered ad-hoc owner checks

See `docs/permissions-model.md` for the canonical current contract.

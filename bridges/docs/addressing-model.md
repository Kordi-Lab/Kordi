# Bridges Human-Friendly Addressing Model

This document defines the current Bridges alias-resolution model for CLI and skills.

The goal is to let people address peers without always copying raw `kd_...` node IDs while keeping resolution rules explicit and predictable.

## 1. Current selector types

Bridges currently accepts these peer selectors for project-scoped `ask`:

1. **raw node ID**
   - example: `kd_abc123...`
2. **project display name**
   - example: `alice-coder`
3. **project owner selector**
   - example: `owner`
4. **explicit role selector**
   - example: `role:research`

Current scope note:
- raw node IDs work with or without a project
- all non-node selectors are currently **project-scoped** and require `--project`

## 2. Resolution order

When the CLI resolves a selector, it uses this order:

1. exact raw node ID (`kd_...`) wins immediately
2. exact case-insensitive `displayName` match within the project
3. `owner` resolves the unique member with role `owner`
4. `role:<role>` resolves the unique member with that role

If nothing matches, the CLI fails with an explicit error.

## 3. Ambiguity rules

Bridges intentionally rejects ambiguous selectors.

### Duplicate display names
If multiple members share the same display name:
- the selector is rejected
- the error lists the matching node IDs
- the caller must use a raw node ID or a less ambiguous selector

### Duplicate role selectors
If multiple members share the same role and the caller uses `role:<role>`:
- the selector is rejected
- the error lists the matching node IDs

### Owner selector
`owner` is only valid if the project currently has exactly one owner.

## 4. Why non-node selectors are project-scoped

Display names and roles are not globally unique identifiers.

A selector like `alice` or `role:research` is only meaningful relative to:
- the current project membership
- the current project roles

That is why Bridges requires `--project` before resolving non-node selectors.

## 5. What Bridges does not yet implement

Bridges does **not** yet implement:
- arbitrary persistent personal contact aliases
- global alias resolution across all projects
- automatic owner-name routing separate from project display names / roles
- multi-hop disambiguation flows in the CLI

For now, the concrete addressing model is:
- raw node IDs for exact global addressing
- project display names for human-friendly project-local addressing
- `owner` and `role:<role>` for limited role-based routing where unique

## 6. Current CLI / skill contract

Current supported behavior:
- `bridges ask <selector> "..." --project <proj_id>` may use:
  - node ID
  - display name
  - `owner`
  - `role:<role>`
- skill wrappers should prefer these selectors before asking users to manually copy node IDs

## 7. Contributor guidance

When extending addressing:
- keep resolution deterministic
- reject ambiguity explicitly rather than guessing
- prefer project-scoped selectors unless a selector is truly global
- document the resolution order whenever a new selector type is added

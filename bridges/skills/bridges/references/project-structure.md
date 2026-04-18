# Project Structure

## Project workspace

Created by `bridges create` or `bridges join`:

```
your-project/
├── .shared/                    # Optional shared workspace notes/files
│   ├── PROJECT.md
│   ├── TODOS.md
│   ├── DEBATES.md
│   ├── DECISIONS.md
│   ├── PROGRESS.md
│   ├── CHANGELOG.md
│   └── artifacts/
├── .bridges/                   # Local-only Bridges metadata
│   ├── project.json            # Local project metadata
│   ├── conversation-memory/    # Local per-peer session memory
│   └── sync-approval.json      # Present only when risky sync needs approval
├── .git/                       # Optional; created on first `bridges sync`
└── .gitignore                  # Optional; created on first `bridges sync`
```

`bridges create` and `bridges join` do **not** require git hosting. The core Bridges network works with project membership, messaging, publish, and session state alone. `bridges sync` is an optional layer for exchanging `.shared/` files.

## project.json

```json
{
  "project_id": "local-metadata-only",
  "slug": "backend-rewrite",
  "display_name": "Backend Rewrite",
  "createdAt": "2026-03-24T10:00:00Z"
}
```

Do not treat `.bridges/project.json` as the authoritative coordination-server project record. Use the saved `proj_...` ID from CLI output for server operations.

## Shared markdown files

### TODOS.md
```markdown
# Todos

- [ ] Write API spec @kd_bob_main (added by kd_alice_coder, 2026-03-24)
- [x] First collaboration checkpoint completed (done 2026-03-24)
```

### DEBATES.md
```markdown
# Debates

## debate_001: gRPC vs REST for the API (open)
Started by kd_alice_coder on 2026-03-24

### Positions
**kd_alice_coder**: REST — simpler, better tooling, our team knows it.
**kd_bob_main**: gRPC — type-safe, faster, better for internal services.
```

### DECISIONS.md
```markdown
# Decisions

## debate_001: gRPC vs REST for the API
Decided: REST (2 votes REST, 1 vote gRPC)
Date: 2026-03-24
```

### PROGRESS.md
```markdown
# Progress

## kd_alice_coder (Alice / Claude Code) — code-review
**Status**: active
**Working on**: Refactoring auth middleware
**Last update**: 2026-03-24 14:30
**Blocked**: Waiting for API spec from Bob

## kd_bob_main (Bob / OpenClaw) — general
**Status**: active
**Working on**: API spec for v2 endpoints
**Last update**: 2026-03-24 14:15
```

### CHANGELOG.md
```markdown
# Changelog

- 2026-03-24 14:15 published artifact `api-spec-draft.yaml`
- 2026-03-24 14:00 added deployment decision notes
- 2026-03-24 13:00 initialized project structure
```

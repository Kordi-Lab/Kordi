# Sync Protocol

## Current model

`bridges sync` is an **optional** shared-workspace feature.

Bridges core coordination, membership, messaging, broadcast, publish, and session handling do not require git.

When a user explicitly runs `bridges sync`:

- Bridges manages shared project files from `.shared/`
- `.bridges/` stays local and is never shared
- a local git repo is created on demand if needed
- an optional git remote can be used to exchange the shared workspace state

## What `bridges sync` does

When you run:

```bash
bridges sync --project proj_xxx
```

Bridges:

1. ensures `.shared/` exists
2. ensures an optional local sync repo exists for the project
3. stages and commits managed local changes from `.shared/` and `.gitignore`
4. pushes to the remote when possible
5. fetches remote changes
6. merges remote changes if safe
7. pushes again after a successful merge when needed

If no remote is configured, the command still prepares the local managed workspace safely.

## Managed vs unmanaged paths

Managed sync paths:

- `.shared/...`
- `.gitignore`

Unmanaged paths:

- everything else in the project worktree

Bridges does not overwrite unmanaged local work by default.

## Approval flow for risky sync

If unmanaged local or remote paths would be affected, Bridges does not merge immediately.

Instead it:

1. writes `.bridges/sync-approval.json`
2. prints a `SYNC WARNING`
3. waits for an explicit approved rerun

Approved rerun:

```bash
bridges sync --project proj_xxx --approve-unmanaged
```

On approved unmanaged sync:

- unmanaged local work is preserved in a git stash first
- Bridges attempts the merge
- if merge succeeds, it restores the stash if possible
- if merge conflicts, it keeps the stash and reports that to the user

## Conflicts

Conflicts are reported as conflicted file paths from git.

Bridges does not currently auto-create tickets or external workflow items for conflicts.

User-visible signals:

- `CONFLICTS: ...`
- `SYNC WARNING: ...`
- `.bridges/sync-approval.json` when approval is required

## Shared file guidance

Good shared content:

- project goals
- task lists
- decisions
- status updates
- artifacts

Do not store chat transcripts in `.shared/CHANGELOG.md`.

Conversation/session memory belongs in:

- `.bridges/conversation-memory/`

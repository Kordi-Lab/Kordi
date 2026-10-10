# Memory

Kordi keeps a small amount of remembered context so agents do not repeat the same mistakes. This page lists what is kept, where it lives, who can read it, and what each control deletes. Cloud runs also keep a technical replay log, described under [Replay state](#replay-state).

## What Kordi remembers

| Layer | Where it lives | Who can read it | How to control it |
| --- | --- | --- | --- |
| Account memories | The Kordi account on the server. Each Mac keeps a cache. | You, and agents running for your account on any device or in cloud runs. | Global memories in account settings; the others on each conversation's Memory tab. |
| Bridge conversation memory | A file on the Mac running the CLI bridge. | Only the bridge on that Mac. | `list` and `reset` commands of the CLI bridge. |

## Account memories

A memory is one short note an agent saved to do better next time, for example a correction you made. Each memory has a scope, a source (a correction, a repeated failure, an outcome, or added by hand), and text of at most 500 characters.

There are four scopes:

| Scope | Scope id | Used for |
| --- | --- | --- |
| `global` | Always `account`, with no label. | Preferences you want everywhere, such as "from now on, answer in British English". |
| `conversation` | The session id. | Anything tied to one chat. This is the default. |
| `group` | The group id. | Facts about one group. |
| `project` | The project root path. | Facts about one project. |

The server rejects a global memory with any scope id other than `account` (`invalid_scope_id`) and drops any label sent with it. Agents write global memories only when you say a preference should apply everywhere ("from now on", "always", "in general"); everything else stays in its conversation, group, or project scope.

Agents save memories with the `reflection` tool, on the Mac and in cloud runs. In cloud runs the runner reads the account's memories at run start: the owner's global memories plus the conversation's and the group's. The `## Memories` prompt section lists them in a Global block first, then the conversation and group blocks. The runner saves through the runner memory route for the run.

Agents avoid duplicates themselves. Before saving, the agent reads the memories for that scope (the artifact file on the Mac, the `## Memories` section in cloud runs) and does not save a memory that repeats or restates one already there. When you change a preference, the agent saves the corrected version, and you can edit or delete the old one. As a safety net, the server and the Mac treat the same text in the same scope as the same memory: the save returns the existing memory, and the tool tells the agent "Memory already saved: <text>" instead of reporting a new one.

The server is the source of truth, so every device and every cloud run sees the same memories. The Mac keeps a cache in its session database and rewrites the `reflection-lessons/<scope>/<scope-id>.md` files in the artifacts directory from the server list. Global memories live in one file, `reflection-lessons/global/account.md`. The Mac prompt section lists the global file first, then the conversation, project, and group files that exist, and tells the agent to read the relevant file before relying on memories.

- Signed in, a new memory is saved to the server first and the local files are rewritten from the server list.
- Signed out, a memory is saved locally with a pending marker and uploaded at the next sign-in. If the server cannot be reached, the memory is also kept locally and uploaded later. A memory the server rejects is not saved anywhere.
- Files that existed before this version are uploaded once, line by line, in their original order.

Every save and edit passes a guard that runs on the server and, before the request, on the Mac. The guard is a floor, not a classifier. It rejects:

- Text that is empty or longer than 500 characters after whitespace is collapsed.
- When "Keep sensitive details out of memories" is on, text that matches a short keyword list in one of four categories: health details, financial details, credentials, and relationship or identity details. It also matches a few patterns such as long card-style digit runs and common key prefixes. The error names the category and asks for a memory about the task instead.
- Text that repeats twelve or more consecutive words from a member who turned off AI use. The comparison ignores case and punctuation. Eleven shared words pass.

The keyword list is narrow on purpose. It will miss some sensitive text and will sometimes reject harmless text.

## Settings

There are two switches, both on by default.

- Let Kordi save memories. When off, memories are not read on any device and agents cannot save new ones: the Mac removes the `reflection` tool and its prompt section, and cloud runs do the same. Nothing is deleted. Turning it back on reads the stored memories again.
- Keep sensitive details out of memories. Controls the keyword part of the guard above.

The switches are an account setting on the server. The Mac mirrors them into the global settings file as `memory.memory_enabled` and `memory.exclude_sensitive`, which is also what applies when you are signed out.

On desktop, open account settings and choose the Memory tab. On iPhone, open the account sheet and choose Memory. Account settings show only global memories, the two switches, and "Forget everything". Conversation, group, and project memories are shown on that conversation's Memory tab (a tab in the desktop conversation header, and the Memory tab of the iPhone session detail), where they can be edited and deleted. These screens hide the Memory section when the server does not report `memoryVersion` in its capabilities.

"Forget everything" in account settings still removes every memory in every scope. A group memory's scope id is the group id (`session:group:<id>` stripped to `<id>`), and only the account that saved a memory sees it.

## What each control deletes

- Delete one memory. Archives that memory on the server. It is no longer listed or read. The Mac files are rewritten from the server list at the next sync.
- Forget everything. Archives every memory of the account and deletes the account's replay state in the same request. It returns both counts. Devices drop the memories at their next sync.
- Account deletion. Memories and memory settings are rows tied to the account with `ON DELETE CASCADE`, so deleting the account removes them, including archived rows. Replay state has no foreign key to the account, so it is removed through the account deletion register planned in the design document, not by a cascade.

Archived rows stay on the server until the account is deleted, but they are hidden and never read by agents. Every write is audited. The event names are `memory_saved`, `memory_updated`, `memory_deleted`, `memory_forget_all`, `memory_settings_updated`, `memory_rejected`, and `omp_state_cleared`.

## Replay state

Cloud agent runs keep the provider message log of a run so the same run can resume without replaying everything. This is the replay state. It is a technical log, not content you wrote, so the Memory settings do not show it. Only the runner that resumes the same run reads it. It was never part of sync replay, digests, or the context other members see. "Forget everything" also clears it, and so does account deletion. Clearing it is safe: a later run starts from the conversation instead of resuming from the log.

## Bridge conversation memory

The CLI bridge keeps its own per-conversation memory in `bridges/cli/src/conversation_memory.rs`. It stays on the Mac, is not synced, and is not covered by the account switches. Use the bridge's `list` command to see it and `reset` to clear it. The desktop Memory tab names it in a read-only row.

## Developer notes

Account routes, all scoped to the signed-in account:

- `GET /v1/cloud/memory`, `POST /v1/cloud/memory`, `DELETE /v1/cloud/memory` (forget everything; returns `{ "archived": n, "clearedRuns": m }` and writes both `memory_forget_all` and `omp_state_cleared`)
- `PATCH /v1/cloud/memory/{memoryId}`, `DELETE /v1/cloud/memory/{memoryId}`
- `GET /v1/cloud/memory/settings`, `PUT /v1/cloud/memory/settings`
- `GET /v1/cloud/agent-runs/omp-state` (count), `DELETE /v1/cloud/agent-runs/omp-state`. Clients do not call these; they remain for support and account deletion flows.

Runner routes, authorized by the run lease: `GET /v1/cloud/agent-runs/{runId}/memory` and `POST /v1/cloud/agent-runs/{runId}/memory`.

`GET /v1/cloud/auth/capabilities` returns `memoryVersion: 1`. Clients hide the Memory section without it.

The design and decisions are in [development/issue-1710-memory-controls.md](development/issue-1710-memory-controls.md). Guard rules live in `agent/crates/tools/src/memory_guard.rs`; the server store is `bridges/cloud-server/src/memory_store/`.

To preview without a server:

- iPhone: launch with `--preview-memory` to open the account sheet on the Memory screen with sample data.
- Desktop: open `app/desktop/tests/visual/memorySettings.html` (account settings) or `app/desktop/tests/visual/conversationMemory.html` (a conversation's Memory tab; add `?chat=group` for a group chat) through `KORDI_DEV_PREVIEW_PATH`. They need no sign-in.

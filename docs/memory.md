# Memory

Kordi keeps a small amount of remembered context so agents do not repeat the same mistakes. This page lists what is kept, where it lives, who can read it, and what each control deletes.

## What Kordi remembers

| Layer | Where it lives | Who can read it | How to control it |
| --- | --- | --- | --- |
| Account memories | The Kordi account on the server. Each Mac keeps a cache. | You, and agents running for your account on any device or in cloud runs. | Memory tab in desktop account settings, Memory screen on iPhone. |
| Replay state | The server, keyed by cloud agent run and owned by your account. | Only the runner that resumes the same run. It is not shown to anyone. | "Clear replay state" in the same Memory settings. |
| Bridge conversation memory | A file on the Mac running the CLI bridge. | Only the bridge on that Mac. | `list` and `reset` commands of the CLI bridge. |

## Account memories

A memory is one short note an agent saved to do better next time, for example a correction you made. Each memory has a scope (conversation, group, or project), a source (a correction, a repeated failure, an outcome, or added by hand), and text of at most 500 characters.

Agents save memories with the `reflection` tool, on the Mac and in cloud runs. In cloud runs the runner reads the account's memories at run start and saves through the runner memory route for the run.

The server is the source of truth, so every device and every cloud run sees the same memories. The Mac keeps a cache in its session database and rewrites the `reflection-lessons/<scope>/<scope-id>.md` files in the artifacts directory from the server list. The agent reads those files as before, so the prompt path does not change.

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

On desktop, open account settings and choose the Memory tab. On iPhone, open the account sheet and choose Memory. The Settings Memory page lists conversation and project memories. Group memories are listed on the group's info page instead (the desktop group details dialog, and the "Memory" tab of the iPhone group detail sheet), where they can be edited and deleted. These screens hide the Memory section when the server does not report `memoryVersion` in its capabilities.

"Forget everything" in Settings still removes every memory, including group ones. A group memory's scope id is the group id (`session:group:<id>` stripped to `<id>`), and only the account that saved a memory sees it.

## What each control deletes

- Delete one memory. Archives that memory on the server. It is no longer listed or read. The Mac files are rewritten from the server list at the next sync.
- Forget everything. Archives every memory of the account and returns the count. Devices drop them at their next sync.
- Clear replay state. Deletes the account's replay state rows and returns the count. Memories are not touched.
- Account deletion. Memories and memory settings are rows tied to the account with `ON DELETE CASCADE`, so deleting the account removes them, including archived rows. Replay state has no foreign key to the account, so it is removed through the account deletion register planned in the design document, not by a cascade.

Archived rows stay on the server until the account is deleted, but they are hidden and never read by agents. Every write is audited. The event names are `memory_saved`, `memory_updated`, `memory_deleted`, `memory_forget_all`, `memory_settings_updated`, `memory_rejected`, and `omp_state_cleared`.

## Replay state

Cloud agent runs keep the provider message log of a run so the same run can resume without replaying everything. This is the replay state. It is a technical log, not content you wrote, so Kordi shows only a run count and a clear action. It was never part of sync replay, digests, or the context other members see. Clearing it is safe: a later run starts from the conversation instead of resuming from the log.

## Bridge conversation memory

The CLI bridge keeps its own per-conversation memory in `bridges/cli/src/conversation_memory.rs`. It stays on the Mac, is not synced, and is not covered by the account switches. Use the bridge's `list` command to see it and `reset` to clear it. The desktop Memory tab names it in a read-only row.

## Developer notes

Account routes, all scoped to the signed-in account:

- `GET /v1/cloud/memory`, `POST /v1/cloud/memory`, `DELETE /v1/cloud/memory` (forget everything)
- `PATCH /v1/cloud/memory/{memoryId}`, `DELETE /v1/cloud/memory/{memoryId}`
- `GET /v1/cloud/memory/settings`, `PUT /v1/cloud/memory/settings`
- `GET /v1/cloud/agent-runs/omp-state` (count), `DELETE /v1/cloud/agent-runs/omp-state`

Runner routes, authorized by the run lease: `GET /v1/cloud/agent-runs/{runId}/memory` and `POST /v1/cloud/agent-runs/{runId}/memory`.

`GET /v1/cloud/auth/capabilities` returns `memoryVersion: 1`. Clients hide the Memory and Replay state sections without it.

The design and decisions are in [development/issue-1710-memory-controls.md](development/issue-1710-memory-controls.md). Guard rules live in `agent/crates/tools/src/memory_guard.rs`; the server store is `bridges/cloud-server/src/memory_store/`.

To preview without a server:

- iPhone: launch with `--preview-memory` to open the account sheet on the Memory screen with sample data.
- Desktop: open `app/desktop/tests/visual/memorySettings.html` through `KORDI_DEV_PREVIEW_PATH`. It needs no sign-in.

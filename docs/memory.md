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
| `group` | The group id. | Facts about one group, shared by its members. |
| `project` | The project root path. | Facts about one project. |

The server rejects a global memory with any scope id other than `account` (`invalid_scope_id`) and drops any label sent with it. Agents write global memories only when you say a preference should apply everywhere ("from now on", "always", "in general"); everything else stays in its conversation, group, or project scope.

Agents save memories with the `reflection` tool, on the Mac and in cloud runs. In cloud runs the runner reads the account's memories at run start: the owner's global memories plus the conversation's and the group's. The `## Memories` prompt section lists them in a Global block first, then the conversation and group blocks. The runner saves through the runner memory route for the run. Each save passes a `category` (the list is in [Developer notes](#developer-notes)) and an optional `confidence` (`low`, `medium`, `high`); a save without a category is filed as `general_preferences`. Agent saves are model-inferred, and the person's own edits win over them. The Mac cache files write each memory as `- <timestamp> [<source>|<category>|<declaration>] <text>`; older files with `[<source>]` still parse.

Agents avoid duplicates themselves. Before saving, the agent reads the memories for that scope (the artifact file on the Mac, the `## Memories` section in cloud runs) and does not save a memory that repeats or restates one already there. When you change a preference, the agent saves the corrected version, and you can edit or delete the old one. As a safety net, the server and the Mac treat the same text in the same scope as the same memory: the save returns the existing memory, and the tool tells the agent "Memory already saved: <text>" instead of reporting a new one.

The server is the source of truth, so every device and every cloud run sees the same memories. The Mac keeps a cache in its session database and rewrites the `reflection-lessons/<scope>/<scope-id>.md` files in the artifacts directory from the server list. Global memories live in one file, `reflection-lessons/global/account.md`. The Mac `## Memories` prompt section inlines the memories from these files in a Global block first, then This conversation, This project, and This group blocks, newest first, with the same caps as cloud runs (40 memories and 8000 characters, then "(more memories omitted)"). It also lists the file paths, so the agent can read a scope's file before saving and the `reflection` tool can skip duplicates. The system prompt shows the memories as of the start of the session and does not change during the conversation. A brand-new conversation gets its memories, including group memories, into the system prompt before the first message; an existing conversation whose prompt lacks some current memories receives them as a memory update note. When memories change during a conversation, for example after an edit or delete in Settings, the next message is preceded by a hidden "memory update" note that lists what was added and removed and the current memories, so the agent follows the change.

On the Mac and in cloud runs, the prompt tells the agent that memories are current and take precedence over older instructions earlier in the conversation when they conflict. In cloud runs it also tells the agent never to reveal, quote, or summarise the owner's global, conversation, or project memories to anyone but the owner (it applies them silently and, if asked, says only that it is the owner's preference); a group's shared memories may be discussed with that group's members.

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

A group memory's scope id is the group id (`session:group:<id>` stripped to `<id>`). On the Mac the group scope id is the cloud group id, resolved from the local group session through the chat sync mapping. Group memories are shared: every active member of the group sees them, every member's agent reads them, and any active member can edit or delete them. Only an active member can save or edit one, the saver included (`403 not_a_group_member`); a former member can still delete the group memories they saved, but no one else's. The same text saved by two members is one memory, and an edit that would repeat another live memory in the same scope is refused (`409 memory_exists`). Group memories are always checked with the sensitive filter on, whatever the writer's own setting. In cloud runs an agent may save only into the scopes of the current conversation (its conversation ids and its group), never into a project, and into `global` only when the owner made the request; anything else is refused with `403 memory_scope_not_allowed`. Every memory in the server responses carries `ownerAccountId` and `ownerName`, so the Memory tab shows who saved each one. Other memories are seen only by the account that saved them.

"Forget everything" in account settings removes every memory you saved, in every scope. Group memories saved by other members stay.

## What each control deletes

- Delete one memory. Archives that memory on the server. It is no longer listed or read. The Mac files are rewritten from the server list at the next sync.
- Forget everything. Archives every memory the account saved (other members' group memories stay) and deletes the account's replay state in the same request. It returns both counts. Devices drop the memories at their next sync.
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

Each memory has a category, a declaration type and an optional profile (#1977). Saves accept `category`, `confidence` (`low`, `medium`, `high`) and `declaredBy` (`user` or `agent`); a missing category is `general_preferences`, and without `declaredBy` a `manual` or `import` source is user-declared and every other source model-inferred. The sources are `user_correction`, `repeated_failure`, `outcome`, `manual`, `digest` (saved by a digest run, below) and `import` (imported by the Mac from the person's AGENTS.md or CLAUDE.md files, #2054). Runner saves are always model-inferred. `PATCH` accepts `text`, `category`, `profileId`, `addProfileId` and `removeProfileId` (see [Several cards per memory](#several-cards-per-memory)); a text edit makes the memory user-declared. Responses add `category`, `declarationType`, `confidence`, `profileId` (the one card the person added the memory to, when there is exactly one), `profileKind` (`work`, `health`, `daily`, `all`, that card's kind, or null; always null for group memories), `profileIds` (the cards the memory feeds, in profile order) and `excludedProfileIds` (the cards the person removed it from). The categories are `general_preferences`, `goals_and_constraints`, `health_context`, `education_learner_profile`, `work_context`, `purchase_history_preferences`, `values_and_ethics`, `location_context`, `coordination_context` and `hcp-custom:task_lessons`. A group memory may not use the health, location, purchase or values categories (`memory_category_not_shared`) or be filed to a profile (`memory_profile_not_allowed`).

Memories are routed to Grounding profiles by category. `work_context` and `education_learner_profile` go to the Work profile, `health_context` to Health, `location_context` and `purchase_history_preferences` to Daily tasks, and `coordination_context` to every fixed-kind profile (listed with `everyProfile: true` while it is shown through its category). The other categories stay prompt-only. The person can add a memory to more cards or remove it from some (below); custom profiles receive added memories only. Group memories never route to a profile. `GET /v1/cloud/common-ground/profiles/{profileId}/memories` lists the owner's memories on that card, newest first (at most 500); another account's profile is not found. The card view (`GET /v1/cloud/common-ground/card`, the build and edit responses) and each entry of `GET /v1/cloud/common-ground/profiles` carry `memoriesSinceBuild`: routed memories updated after the card was built, or all of them when it never was. Every card change of a memory updates it, so it counts.

### Several cards per memory

A memory may feed several cards (#2035). The person's choices are rows of `cloud_account_memory_card_overrides` (`memory_id`, `profile_id`, `included`), removed with the memory or the profile. A memory's cards are the owner's profiles its category routes to, minus the cards with an `included = false` row, plus the cards with an `included = true` row. A fixed-kind card's build reads the memories on that card. A custom card's build also reads every memory not added to any card and not removed from that card, until per-card sources land (#1971).

`PATCH /v1/cloud/memory/{memoryId}` changes cards with:

- `addProfileId`: undoes a removal from that card, or adds the memory to it. Adding a card the category already routes to changes nothing.
- `removeProfileId`: removes the memory from that card. A card the memory is not on returns `404 memory_profile_not_found`.
- `profileId` (legacy): makes that card the memory's only card (it is added, every other card its category routes to is removed); `null` clears every choice, so the category decides again.

A profile of another account returns `404 profile_not_found`, and any card change on a group memory returns `403 memory_profile_not_allowed`. The old `profile_id` column of `cloud_account_memories` is kept for older servers and always holds the one added card, or null. Migration 0150 turned every existing `profile_id` into an added card plus removals for the other cards its category routed to, so pinned memories keep feeding only their pinned card.

`GET /v1/cloud/auth/capabilities` returns `memoryVersion: 3`, which means categories, profile routing and several cards per memory (version 2 had a single `profileId`); clients that know only version 1 keep the old Memory UI. Clients hide the Memory section without it.

The design and decisions are in [development/issue-1710-memory-controls.md](development/issue-1710-memory-controls.md). Guard rules live in `agent/crates/tools/src/memory_guard.rs`; the server store is `bridges/cloud-server/src/memory_store/`.

To preview without a server:

- iPhone: launch with `--preview-memory` to open the account sheet on the Memory screen with sample data.
- Desktop: open `app/desktop/tests/visual/memorySettings.html` (account settings) or `app/desktop/tests/visual/conversationMemory.html` (a conversation's Memory tab; add `?chat=group` for a group chat) through `KORDI_DEV_PREVIEW_PATH`. They need no sign-in.

### Digest memories

Digest runs save memories from recent conversations (#2053). The digest input carries `memories`, the owner's current memories (`text`, `scope`, `scopeId`, `category`; at most 40, 200 characters each, none when memory is off), so the model does not repeat one; incremental runs carry it too. The reply may add `memories`: at most 3 entries of `text` (500 characters at most), `category`, `confidence`, `scope` (`conversation`, `group` or `global`), `sessionId` (omitted for global) and `sourceMessageIds`. A malformed entry is dropped; the digest's own items are unaffected.

After the digest is stored, `digest/memories.rs` checks each entry and saves it through the normal save as the owner, with source `digest`, model-inferred, at the given confidence. Every source message must be in the run's snapshot, still current, and in the given session. Conversation and global memories need the owner's own messages (not an agent's); the conversation scope id is the session id. A group memory's scope id is the sources' group conversation, which must be a group the owner is an active member of, in a category allowed for groups. `health_context` is refused, the same text (trimmed, any case) already in the scope or earlier in the reply is skipped, and the memory switch, the sensitive filter and the other save rules apply. A refused entry is skipped with a `digest_memory_skipped` audit row that names the reason, never the text; a saved one writes `memory_saved` with `via: "digest"`. The digest completes whatever happens to its memories. The snapshot never keeps them.

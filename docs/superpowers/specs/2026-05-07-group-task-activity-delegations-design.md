# Group Task Activity Delegations Design

## Goal

Sync agent-delegation task activity at the group-session level and show each task with its participants in the Tasks UI.

## Scope

Task activity means agent delegation only: requests involving bridge/local agents such as `@RemoteKordi` or a local Kordi relay. Normal bridge-person group fanout remains message delivery activity and does not count as a task.

## Current behavior

Group session messages are synced through the bridge/canonical session pipeline and render in chat, but `session-message` and `session-relay` paths return before creating canonical delegated exchanges. As a result, group agent requests can appear as messages without a corresponding task/delegation record. The current chat/project Tasks panels are also mostly placeholder/static UI and do not consume canonical delegated exchanges or participant metadata.

Relevant code paths:

- `app/desktop/src-tauri/src/canonical_sessions/bridge_sync.rs` groups bridge outreach with `message_scoped_outreach_groups(...)` and calls `sync_bridge_outreach_into_parent_session(...)`.
- `app/desktop/src-tauri/src/canonical_sessions/parent_sessions/outreach.rs` returns early for `session-message` and `session-relay`, before `create_delegated_exchange_in_db(...)`.
- `app/desktop/src-tauri/src/canonical_sessions/parent_sessions/relay.rs` writes relay messages with `delegated_exchange_id: None`.
- `app/desktop/src/features/canonical/readModel/indexes.ts` counts delegated exchanges but does not expose task activity records to panels.
- `app/desktop/src/pages/ChatDetailPanel.tsx` has hardcoded Tasks content.
- `app/desktop/src/pages/ProjectDetailPanel.tsx` uses project mock/static task counts.

## Backend design

Add canonical delegated exchange creation for group-level agent delegation.

For group `session-message` / `session-relay` outreach:

1. Detect agent delegation when the outreach target is an agent or the relay resolves to a local/remote agent identity.
2. Create or update one stable `delegated_exchanges` row for the group parent session.
3. Use a stable group-level delegation id derived from the parent session and request id, not the target conversation id, so fanout copies do not create duplicates.
4. Link request/response messages to the delegated exchange where possible.
5. Preserve existing message rendering and dedupe behavior.

Stable id format:

```text
delegation:bridge-session-message:{parent_session_id}:{bridge_request_id_or_parent_message_id}
```

Status mapping:

- `sending`, `awaitingReply`, `processing`, no terminal response → `processing`
- `completed`, `complete`, `responded`, `read` response → `complete`
- `processing_failed`, `failed` → `failed`
- `cancelled` → `cancelled`
- timeout state → `timeout` or `failed`, matching existing bridge timeout behavior

## Frontend read-model design

Extend canonical read model output with task activity records derived from `delegatedExchanges`.

Each task activity should include:

- task id
- session id
- status
- initiator identity summary
- target identity summary
- participant summaries for the parent group session
- created/updated timestamps
- bridge conversation id/request id when present
- optional error

The read model should keep task count and task list consistent:

- `canonicalDelegatedExchangeCount` remains the count source.
- New `taskActivities` carries renderable details.
- Project/session task counts should prefer canonical task counts over static workspace mock counts when canonical data exists.

## UI design

Replace placeholder Tasks content with canonical task activity.

Chat Tasks panel:

- Show active conversation task activities.
- Each task row shows target agent, status badge, initiator, and participants.
- Empty state: “No delegated tasks in this session yet.”

Project Tasks panel:

- Show tasks for the active project session first.
- Show project aggregate count across project sessions where available.
- Each task row includes participants so users can see who was involved.

## Testing plan

Backend Rust tests:

1. Group bridge-agent `session-message` creates a delegated exchange.
2. Duplicate group fanout copies reconcile to one delegated exchange.
3. Group local-agent relay creates a delegated exchange.
4. Non-agent group person fanout does not create a delegated exchange.
5. Exchange status updates from processing to complete/failed/cancelled.

Frontend TypeScript tests:

1. Read model maps delegated exchanges to task activity records with participants.
2. Task count matches task activity length for canonical sessions.
3. Project/session view models prefer canonical task counts.
4. Task panel helper returns empty state when no activity exists.

## Non-goals

- Do not count human-only group fanout as tasks.
- Do not redesign the whole task management system.
- Do not add persistence tables beyond existing canonical delegated exchanges.
- Do not change bridge delivery semantics for normal messages.

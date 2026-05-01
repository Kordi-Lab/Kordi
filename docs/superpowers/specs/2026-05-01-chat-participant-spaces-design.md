# Chat Participant Spaces Design

## Issue

GitHub issue: #171 — Redesign Chats sidebar around participant spaces and explicit group invites.

## Approved direction

Kordi should move Chats from a flat session list toward a communication-app model:

1. First-level sidebar rows are participant spaces.
2. Drilling into a space reveals sessions/threads inside that participant set or named group.
3. Named groups are durable and support explicit invites.
4. `@` mention remains inline delegation, not the only way to build membership.

The approved message semantics are:

- Active human members receive group messages.
- Invited or pending members do not receive ordinary group messages yet.
- Agents respond only when explicitly mentioned with `@`.

## Current code summary

- `app/desktop/src/pages/WorkspaceSidebar.tsx` renders Chats as a flat `filteredConversations.map(...)` session list.
- `app/desktop/src/app/useWorkspaceViewModels.ts` builds session-level `chatConversations` from local runtime sessions plus Bridge conversations.
- `app/desktop/src/features/canonical/sessionReadModel.ts` hydrates canonical sessions but only groups the default-agent relationship special case.
- `app/desktop/src-tauri/src/canonical_sessions.rs` already supports `kind = 'group'` and participant rows, but `stable_session_id()` does not include participant sets and `upsert_participant()` forces `state = 'active'`.
- `session_participants.state` and TypeScript types already support `active | invited | pending | left`.

## Architecture

Use a hybrid model:

- Direct human and direct agent spaces are derived from current canonical session participants. This avoids extra persistence for direct chats.
- Named groups are durable participant spaces. Add explicit storage for group spaces and group membership in later PRs.
- Sessions remain the transcript unit. Spaces are navigation and membership units.

The work should ship in separate PRs:

1. Participant-space read model.
2. Sidebar drill-in UI.
3. Durable backend group/space persistence.
4. `+` create flows for direct chat and named group.
5. Explicit invites and group message fan-out.

## Participant-space read model

```ts
export type ParticipantSpaceKind = 'direct-human' | 'direct-agent' | 'group';

export type ParticipantSpaceAvatar = {
  kind: 'human' | 'agent';
  seed: string;
  imageUrl?: string | null;
};

export type ParticipantSpaceSessionViewModel = {
  id: string;
  canonicalSessionId?: string;
  title: string;
  preview: string;
  unread: number;
  updatedAtLabel?: string;
  updatedAtMs: number;
  participantCount: number;
  statusIndicator?: SessionStatusIndicator;
  conversation: Conversation;
};

export type ParticipantSpaceViewModel = {
  id: string;
  kind: ParticipantSpaceKind;
  title: string;
  participants: ConversationParticipant[];
  participantCount: number;
  sessionCount: number;
  unread: number;
  updatedAtLabel?: string;
  updatedAtMs: number;
  preview: string;
  avatarStack: ParticipantSpaceAvatar[];
  sessions: ParticipantSpaceSessionViewModel[];
};
```

Rules:

- Exclude the local self human when computing a space key.
- Direct human key: `direct-human:<canonical human identity id>`.
- Direct agent key: `direct-agent:<canonical agent identity id>`.
- Group key: `group:<participantSpaceId>` when metadata exists, otherwise derived from sorted non-self participant ids for the read-model v1 only.
- For multiple direct sessions with the same participant, show one participant space with `sessionCount > 1`.
- Aggregate unread counts by summing child sessions.
- Latest space timestamp is the maximum latest session timestamp.
- Avatar stack uses canonical participant avatar keys or `conversation.avatarSeed` fallback.
- Session rows retain original `Conversation` objects so existing transcript selection/routing is unchanged.

## Sidebar interaction model

The sidebar remains the existing width:

- default panel width around 248px;
- current min around 220px;
- icon rail remains unchanged.

Chats panel states:

1. Space list: social rows with avatar/avatar stack, title, participant preview, session count, latest time, unread.
2. Session list: selected participant space header with Back action and thread rows.

Drill-in should be state-driven and animated with transform/opacity. Keep both panes mounted where possible so scroll state survives.

## Durable group model

Later backend PR adds:

```sql
CREATE TABLE participant_spaces (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  created_by_identity_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  metadata_json TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE participant_space_members (
  participant_space_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  role TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'invited',
  added_by_identity_id TEXT,
  added_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  metadata_json TEXT,
  PRIMARY KEY(participant_space_id, identity_id)
);
```

Also add `participant_space_id TEXT` to `sessions`.

Group session IDs must be explicit UUID-based ids or include the participant-space id. Do not rely on existing `stable_session_id()` for groups.

## Explicit invite behavior

- Creating a group adds the creator as `active` and selected remote people/agents as `invited` or `pending` depending on transport availability.
- Inviting a person/agent appends a canonical `status` message with `content.kind = 'group-membership-event'`.
- Transcript renders membership events similarly to existing system/status messages, but with copy distinct from `@mention` delegation events.
- Existing `delegation-join-event` remains for `@` involvement and should not be treated as durable membership.

## Acceptance mapping

- Participant-space first page: PR 1 + PR 2.
- 248px compact rows: PR 2.
- Drill-in with Back and scroll preservation: PR 2.
- `+` direct/group creation: PR 4.
- Durable group identity and sessions: PR 3 + PR 4.
- Invite lifecycle states: PR 3 + PR 5.
- Transcript membership events: PR 5.
- `@` mention delegation remains: all PRs must preserve existing mention tests.

## Non-goals for PR 1

- No visual sidebar replacement yet.
- No database migrations yet.
- No group creation dialog yet.
- No message fan-out yet.

PR 1 only adds the read model needed to power the UI safely.

# Chat Create Flows and Group Details Design

## Goal

Build the next #171 slice: make the Chats `+` action open explicit create flows, add people-only group creation, and add a group details/manage surface from the drilled participant-space header.

This PR is a foundation PR. It creates stable local canonical group sessions and local management metadata. It does not implement multi-device group message fan-out; that remains the next slice.

## User-facing behavior

### `+` menu

The Chats `+` button opens a compact menu instead of immediately creating a blank chat. The menu contains:

1. **Chat with person** — select one person contact and open/start a direct person session.
2. **Chat with agent** — select one agent/contact agent and open/start a direct agent chat.
3. **Start group** — select people contacts only and create a group.

The left-rail global `+` should use the same chat-start menu when the user is in the Chats context.

### People-only group creation

The group picker lists only people contacts. Agents are not selectable and are not shown as group members during creation.

A group can be created only after selecting at least two contacts. Including the local user, this makes a group of three or more people.

The default group display name is derived from selected people:

- 2 selected people: `Shuyhere, Shuyhere2` (creator + 2 selected people = 3 humans total)
- More than 2 selected people: `Shuyhere, Shuyhere2 +N more`

The user can override the group display name before creating the group, or rename it later from details. The transcript/session row title remains derived from the first few message tokens, not from the contact name or group display name.

### Stable group identity

Creating a group creates one stable canonical group/session id, e.g. `session:group:<uuid>`. That id is the group id and the shared session id for all participants. It is sent in Bridge invites and group message fan-out as `parentSessionId`; receivers reconstruct the same canonical group session id rather than generating their own local group id.

Later adding/removing members does not change the group id. If the group has a custom display name, adding/removing members also does not change the custom name.

Group metadata stores:

- `groupId` / stable shared group id
- `groupSpaceId` / same value as `groupId` for compatibility with participant-space grouping
- `createdAtMs`
- `createdByIdentityId`
- `adminIdentityIds`
- optional `customName`
- member limit policy metadata (`autoAddUnderMemberCount: 50`)

### Group details and management

When a participant space is drilled in, the header gains a `...` button. For group spaces, it opens a details panel/sheet showing:

- group name
- creation date
- people members
- admins
- session list/count

Admins can:

- rename the group, with the new display name sent to all Bridge-backed group participants as a silent `session-update`
- add people contacts
- remove people contacts, except themselves when they are the only admin
- promote/demote admins, preserving at least one admin

For groups under 50 people, adding a person contact directly makes them an active member without approval. This PR records that local membership state; transport fan-out and remote acceptance behavior are deferred.

### Child session row prefix

Inside a drilled participant-space view, child sessions render with a `#` prefix before the session title, e.g. `# Hi shu`.

When a contact or group row is expanded, unread/status lights move to the child session rows. The parent row remains a structural header and should not duplicate the blue running light from the active child session.

### Mention participant scope

In direct person chats and group chats, the `@` menu is scoped to the people participating in that conversation plus those people's agents, including the local participant's own Kordi. Other Bridge people/agents discovered on the same server are hidden from that conversation's mention menu and send-time mention resolution.

If a Bridge-mentioned agent fails on another user’s machine and does not return a response, the requester sees only a compact red `Failed` delivery state on the original `@` message. Bridge agent failure details are not rendered into shared chat history; local/remote transcripts show a generic compact `Message failed` state instead of provider credential text.

## Data model approach

Use the existing canonical session tables for this foundation instead of adding a new storage table in this PR:

- A group is a canonical session with `kind = 'group'`.
- People membership is represented by `session_participants` rows.
- Admins and group policy metadata are represented in `sessions.metadata_json`.
- Group display name is stored in metadata (`customName`), while session row titles are derived from the first few tokens of the first real message.
- Bridge group rename sync uses a silent `session-update` outreach carrying the shared `groupId`, `parentSessionTitle`, admin ids, and participant list so receivers update the same group without adding transcript noise.

This is intentionally compatible with a future dedicated `participant_spaces` backend. If/when that table is added, the metadata fields can be migrated without changing the UI contract.

## Frontend architecture

Add focused UI helpers rather than growing `WorkspaceSidebar` too much:

- `chatCreateFlows.ts` — derives selectable people/agent options from current contacts/agents and builds default group names.
- `ChatCreateDialog.tsx` — menu/picker/create flow.
- `GroupDetailsDialog.tsx` — details and management UI for selected group participant spaces.

Wire handlers through existing shell args:

- create direct person: use the existing bridge person session path when a contact has bridge identity data; otherwise create a fresh canonical direct-person session. Multiple sessions with the same person are allowed.
- create direct agent: use the existing bridge conversation path when possible; otherwise create/open a canonical direct-agent session.
- create group: create a canonical `group` session with selected people as participants and group metadata.
- manage group: call new canonical management functions and refresh canonical state.

## Backend/API architecture

Add small canonical-session commands rather than broad new infrastructure:

- `desktop_canonical_rename_session(session_id, title)`
- `desktop_canonical_update_session_metadata(session_id, metadata)` or a group-specific update command
- `desktop_canonical_add_session_participants(session_id, identity_ids, added_by_identity_id)`
- `desktop_canonical_remove_session_participant(session_id, identity_id)`
- `desktop_canonical_set_session_participant_role(session_id, identity_id, role)`

Commands validate that the session exists and is a group for group-specific operations. Role management preserves at least one admin.

## Error handling

- Group create is disabled until at least two people contacts are selected.
- If a selected contact lacks a resolvable canonical human identity, show a clear inline error and do not create a partial group.
- Member removal cannot remove the last admin.
- Rename rejects empty names.
- Backend command failures surface in the existing `desktopChatError` area and keep the dialog open.

## Testing

Add TDD coverage for:

- people-only group option derivation and default group name truncation
- start group requiring two selected people contacts
- canonical group creation metadata and stable id behavior
- adding members under 50 without changing id/name
- admin role safeguards
- group details `...` rendering and `#` child session titles

Run full desktop frontend verification and targeted Rust canonical tests before opening the PR.

## Out of scope

- Remote invite delivery and multi-device group fan-out
- Approval flow for groups at or above 50 people
- Full dedicated `participant_spaces` database tables
- Message delivery to every group member

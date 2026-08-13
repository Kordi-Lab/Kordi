# Conversation-Participant Cloud Agent Sharing Design

Issue: #587

## Summary

Cloud Agents created from the Agent page remain private by default. The owner can opt a Cloud Agent into **Shared in conversations with me** access. Once shared, other people can mention that agent in contact and group sessions where the owner is a participant. Replies are clearly attributed as the owner's agent, for example `Project Driver · Alex's Agent`.

This is a focused follow-up to private Cloud Agent creation (#585/#586). It does not introduce public agent discovery, selected-contact ACLs, or broader tool/file sharing.

## Goals

- Add a per-agent Access setting:
  - `Private — only me`
  - `Shared in conversations with me`
- Keep `Private — only me` as the default for new Cloud Agents.
- Let other participants mention a shared Cloud Agent only inside sessions that include the agent owner.
- Support contact sessions and group sessions using the same participant-gated model.
- Show shared-agent mentions and replies with clear owner attribution.
- Route shared-agent requests through Cloud using the owner's Cloud Agent definition and model route.
- Preserve the existing private-agent chat behavior from #585.

## Non-goals

- Public/discoverable agent handles.
- Selected-contact access control lists.
- Workspace-wide sharing.
- Letting shared agents access owner-local private tools/files from someone else's request.
- Full independent local runtime execution on remote users' devices.
- Hard-delete or ownership transfer for agents.

## User Experience

### Owner settings

In the Agent page, a Cloud Agent's Access section becomes editable for owner-created Cloud Agents:

- `Private — only me`
  - The agent appears only to the owner.
  - Other users cannot mention it.
- `Shared in conversations with me`
  - The agent becomes mentionable in contact/group sessions where the owner is a participant.
  - The UI explains that people outside those sessions cannot mention it.

Private remains the initial state after agent creation.

### Mention picker

When a user opens the mention picker in a contact/group session, it includes shared Cloud Agents owned by session participants. Example:

- `@ProjectDriver`
- Secondary label: `Alex's Agent`

The picker does not show a shared agent if its owner is not a participant in the active session.

### Transcript attribution

When a shared agent replies, the transcript header displays owner attribution:

- `Project Driver · Alex's Agent`

This avoids ambiguity with the viewer's own Kordi or another participant's agents.

### Access failure behavior

If a stale mention or synced message references an agent that is no longer shared or whose owner is no longer a participant, the requester sees a short failure notice:

- `Project Driver is no longer available in this conversation.`

## Architecture

### Backend access model

Extend Cloud Agent definitions with an access scope that supports:

- `private`
- `participant_conversations`

The existing server-side owner scoping remains unchanged for owner management endpoints. A new read path is needed for conversation participants to resolve mentionable shared agents without exposing private-only agents.

Recommended backend additions:

1. Migration updates access-scope validation to allow `participant_conversations`.
2. `PUT /v1/cloud/agents/:agent_id` accepts access-scope updates from the owner.
3. A participant-safe lookup/list endpoint returns active shared agents for a set of owner account IDs, filtered to `participant_conversations` only.

The participant-safe response includes only mention-safe fields:

- `agentId`
- `ownerAccountId`
- owner display label if available
- `name`
- `role`
- `description`

It does not return `systemPrompt`, `modelRouting`, private resources, or full skill details to non-owners. The Cloud runtime resolves the full active definition server-side by `agentId` after validating access.

### Desktop sync/state

Desktop already syncs owner-created Cloud Agent definitions for the signed-in owner. Add a shared-agent catalog for agents owned by other session participants:

- Refresh when Cloud diff sync runs or when active session participants change.
- Keep owner-created private agents in the existing owner agent store.
- Keep shared remote agents separate enough to avoid showing them as editable/deletable in the viewer's Agent page.

### Mention eligibility

For an active conversation:

1. Determine participant account IDs from canonical participants/session metadata.
2. Include owner-created local Cloud Agents when owned by the viewer and shared/private rules permit.
3. Include remote shared Cloud Agents whose `ownerAccountId` is in the participant set.
4. Exclude remote shared Cloud Agents when the owner is not a participant.
5. Deduplicate mention handles, preserving owner labels for collisions.

### Runtime routing

When a message mentions a shared Cloud Agent:

- The request targets the shared agent's `agentId` and `ownerAccountId`.
- Cloud validates from server-side session membership data that:
  - the agent is active,
  - access scope is `participant_conversations`,
  - the owner is a participant of the target session, and
  - the requester is also a participant of the target session.

The server must not trust client-supplied participant lists for access decisions.
- The reply uses the owner's Cloud Agent definition/model route.
- Replies are encoded with enough metadata for transcript attribution as `Agent Name · Owner's Agent`.

The implementation must not claim that the remote user's device can execute the shared agent's local tools. Shared-agent replies use Cloud/runtime capabilities only.

## Data Flow

1. Owner changes Access from `private` to `participant_conversations`.
2. Desktop sends an owner-authenticated update to Cloud.
3. Cloud stores the new access scope and emits a sync event.
4. Other users in sessions with the owner refresh shared-agent candidates.
5. A participant types `@ProjectDriver` and sends a message.
6. Desktop encodes the mention target with `agentId` and `ownerAccountId`.
7. Cloud validates participant-gated access and queues/runs the agent reply.
8. The reply syncs into the conversation with owner-attributed agent metadata.
9. Transcript renders `Project Driver · Alex's Agent`.

## Error Handling

- Invalid access scope: server returns a validation error.
- Non-owner attempts to update access: server returns not found/forbidden using the existing owner-scoped behavior.
- Mentioned agent no longer shared: show an unavailable notice.
- Owner no longer participant: show an unavailable notice.
- Missing owner model route/provider auth: reuse existing no-provider/fallback messaging, attributed to the shared agent.
- Duplicate handles: show owner suffixes in picker and preserve unambiguous target IDs in the message metadata.

## Testing

### Backend

- `private` remains default for created agents.
- Owner can update access to `participant_conversations`.
- Unsupported access scopes are rejected.
- Non-owner cannot update another user's agent.
- Shared-agent lookup returns only active `participant_conversations` agents.
- Archived/private agents are excluded from shared lookup.
- Runtime validation rejects requests where the owner is not a participant.

### Desktop/unit

- Access menu shows both options for owner-created Cloud Agents.
- Changing Access updates Cloud and local state.
- Remote shared agents appear in mention candidates only when owner is in the active contact/group session.
- Remote shared agents do not appear when owner is absent.
- Mention handle collisions get owner disambiguation.
- Shared-agent replies render as `Agent Name · Owner's Agent`.
- Existing private Cloud Agent creation/message tests keep passing.

### Manual

- Create a private Cloud Agent; confirm another account cannot mention it.
- Switch Access to `Shared in conversations with me`.
- In a contact session with the owner, another account can mention it and gets a reply.
- In a group session with the owner, another account can mention it and gets a reply.
- In a session without the owner, the agent is not offered in mentions.
- Switch back to private; existing mention availability disappears after sync/refresh.

## Implementation constraints

- Non-owner shared-agent lookup returns labels and IDs only; full prompts and routing stay server-side.
- Participant-gated access must be validated against server-side session membership. If the existing Cloud data model lacks a reliable membership lookup for a session type, the implementation must add or reuse a durable server-side membership source before enabling shared-agent execution for that session type.
- If reliable server-side membership is initially available for only one session type, ship that type first and keep the other disabled rather than weakening validation.

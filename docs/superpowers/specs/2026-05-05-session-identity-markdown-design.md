# Per-Session Identity Markdown Design

## Goal

Keep model-facing identity/collaboration context current without rewriting large participant frames into the system prompt on every turn. Each shared Kordi session gets its own Markdown identity file. Participant/identity events update that file and trigger a model-visible instruction to read it before continuing.

This extends the identity-frame work for issues #101 and #106 by moving volatile participant data into a per-session file while keeping a stable system-prompt rule.

## Requirements

- Keep the base system prompt stable.
- Store current identity, participant, ownership, and permission state in a Markdown file per session.
- Update that Markdown file whenever a participant/identity event changes the state.
- Do not require the model to read the identity file before every response.
- Require the model to read the identity file only:
  - on its first turn in a shared/group/project/Bridge/delegated-agent session, or
  - after a visible participant/identity event appears in the chat.
- Preserve the visible chat UI message style, such as `Kordi User 3's Kordi joined via @mention`.
- Add model-visible event details with the session id/path while keeping the UI display friendly.
- Use Markdown, not JSON, for the model-facing identity file.

## Non-goals

- Do not replace canonical SQLite as the source of truth.
- Do not add a global identity file shared by all sessions.
- Do not rely only on the model parsing natural-language join/leave text.
- Do not include high-cardinality session ids in OpenAI `prompt_cache_key`.
- Do not enable OpenAI extended prompt-cache retention.

## Architecture

### Source of truth

Canonical session tables remain authoritative for identities, participants, owners, membership state, and session metadata. The Markdown file is a generated model-facing projection.

### File location

Each session has its own identity Markdown file under app-managed Kordi storage, exposed to the model by path when relevant.

Suggested logical path shape:

```text
.kordi/session-identities/<session-id>.md
```

The implementation may map this logical path to an app-data location if needed for sandboxing, but the model-visible path should be stable and session-specific.

### Stable system prompt rule

The system prompt should contain a small stable rule, not the full participant graph:

```text
Kordi session identity context:
- Shared, group, project, Bridge, and delegated-agent sessions have a session-specific identity Markdown file.
- Do not read this file before every response.
- Read the current session identity file only on your first turn in that shared session, or when a visible participant/identity event says the file changed.
- Participant/identity events include joins, leaves, removals, renames, owner changes, and permission/allowed-target changes.
- When instructed that the identity file changed, use the read tool on the provided session identity file path before answering.
- After reading it, follow its Current model/self, requester/initiator, participants, owners, replyAs, allowed targets, permissions, and rules until another participant/identity event appears.
```

The stable prompt can mention the behavior. The concrete per-session path comes from the model-visible event/session context.

## Markdown file format

Example:

```md
# Kordi Session Identity Context

Version: v1
Session ID: session-group-456
Session kind: group
Updated at: 2026-05-05T12:34:56Z
Participant graph hash: graph-hash-1
Permission policy hash: policy-hash-1

## Current model / self

- identityId: agent:alice-kordi
- displayName: Alice's Kordi
- kind: agent
- owner: Alice (human:alice)
- replyAs: agent:alice-kordi only

## Requester / initiator

- identityId: human:alice
- displayName: Alice
- kind: human

## Current target

- none

## Participants

| identityId | displayName | kind | role | owner | locality | bridgeNodeId | humanId | agentId | runtime |
|---|---|---|---|---|---|---|---|---|---|
| agent:alice-kordi | Alice's Kordi | agent | self | Alice (human:alice) | local |  | alice | alice-kordi | kordi-desktop |
| agent:bob-kordi | Bob's Kordi | agent | participant | Bob (human:bob) | non-local | bob-node | bob | bob-kordi | kordi-desktop |
| human:alice | Alice | human | requester |  | local |  | alice |  | person |
| human:bob | Bob | human | participant |  | non-local | bob-node | bob |  | person |

## Permissions

- mayImpersonate: none
- reachOut: allowed only for explicit non-local @Person/@Agent mentions in the current user message
- allowedTargets:
  - human:bob
  - agent:bob-kordi
- contextPolicy: recent-window
- requiresApproval: false

## Rules

- Reply only as the `replyAs` identity.
- Do not impersonate any other person or agent.
- Do not prefix replies with speaker labels or identity names.
- Treat canonical identity IDs as authoritative; display names are descriptive only.
- Use the current message author/requester to interpret “I”, “me”, and “my”.
- Do not contact or delegate to another person or agent unless the current user explicitly mentioned that non-local participant and permissions allow it.
```

Rendering should reuse the same sanitization principles as the current identity frame: trim fields, escape Markdown/table-breaking delimiters where needed, sort participants deterministically, and cap untrusted remote payload data.

## Event flow

### Join by mention

1. Alice sends a message mentioning Bob's Kordi.
2. Existing sync/outreach logic adds Bob's Kordi to the canonical session if needed.
3. The app writes/updates the per-session identity Markdown file.
4. The chat UI shows the friendly visible system message:

   ```text
   Bob's Kordi joined via @mention
   ```

5. The model-visible form of that same session message includes structured details, for example:

   ```text
   Bob's Kordi joined via @mention.
   Identity file changed for session session-group-456.
   Read .kordi/session-identities/session-group-456.md before answering.
   ```

6. The model reads the file once, updates its working identity context, then answers.

### Removal or leave

1. A person or agent leaves/is removed.
2. Canonical membership state changes.
3. The identity Markdown file is regenerated.
4. The visible system message is shown, e.g. `Charlie left the chat`.
5. The model-visible details include the same identity file path and read instruction.
6. The model reads the file before answering.

### Normal message with no participant event

No identity file read is required. The model continues using the last identity context it read.

## Prompt caching impact

This keeps the stable system prompt and tool schema near the beginning of the request, preserving OpenAI prompt-cache prefix matching. The per-session identity file path and any read result are variable and session-specific, but they are introduced only when a participant/identity event requires them.

The OpenAI `prompt_cache_key` should remain low-cardinality, for example `kordi:<model>:identity-v1`; it must not include session ids or participant ids.

## Reliability notes

- The app should not rely only on natural language such as `joined` or `left`; event metadata should mark a message as a participant/identity event.
- The UI can display only the friendly text, while the model-visible transcript includes the identity-file-changed instruction.
- If the identity file cannot be read, the model should ask for clarification rather than guessing who it is allowed to speak as or contact.
- The file should be rewritten atomically to avoid partial reads.
- In-flight turns keep their existing identity context; the next turn after the event sees the updated file/read instruction.

## Testing strategy

- Unit-test Markdown rendering for deterministic participant order, owners, permissions, and delimiter escaping.
- Unit-test file path generation per session.
- Unit-test participant join/remove/rename events trigger identity file regeneration.
- Unit-test model-visible transcript includes the path/read instruction while UI-facing text remains friendly.
- Unit-test normal non-event messages do not add read instructions.
- Verify existing identity frame, Bridge, reach_out, prompt-cache, and frontend tests still pass.

## Acceptance criteria

- Each shared/group/project/Bridge/delegated-agent session has a generated Markdown identity file.
- Participant/identity changes update the correct session file.
- Visible chat messages remain friendly.
- Model-visible event messages include the session identity file path and read instruction.
- The system prompt contains only stable file-reading rules, not volatile participant lists.
- The model is not instructed to read the file on every turn.
- Existing OpenAI prompt-cache routing remains low-cardinality.

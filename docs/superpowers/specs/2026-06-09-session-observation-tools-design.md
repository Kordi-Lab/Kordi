# Session Observation Tools Design

## Goal

Add a general read-only session observation tool layer that lets agent sessions search and read related conversation context from the synced local canonical database.

This supports PR #534's side-by-side chat panel by giving any normal agent session a way to discover relevant context across accessible conversations. The side-by-side panel remains only a UI layout for placing a normal agent session beside another chat; it does not introduce a special co-pilot agent type or special co-pilot system prompt.

## Product Decisions

1. **No special co-pilot agent type.** A side panel session is a normal agent session.
2. **No special co-pilot system prompt.** Agent sessions use the same base agent system prompt as other agent sessions.
3. **Tools are available to all agent sessions by default.** `search_sessions` and `read_session` are general Observation tools, not side-panel-only features.
4. **Tool names are generic.** Use `search_sessions` and `read_session`; do not include `kordi` in the tool names.
5. **Search covers all accessible sessions/conversations.** Default scope is all sessions visible to the current user in the local canonical database.
6. **Cloud-backed conversations use the same path.** Cloud and local session data are normally synced into the canonical local database, so v1 tools read local canonical state and do not block on live Cloud fetches.
7. **Read-only only.** Both tools are Observation layer, ReadOnly risk, and safe to run without planning or write approval.

## Reference: PR #534

PR #534 currently adds a side-by-side chat panel. The final #534 semantics should be:

- A user can open a normal agent session beside the current chat.
- The side session can use the same Observation tools as any other agent session.
- The UI should avoid language that implies a new agent class, such as “private co-pilot mode.”
- Better UI language is neutral: “Ask agent,” “Open side session,” or “Side session.”
- Explicit open behavior remains preferred over auto-opening a paired session.

## Architecture

### Runtime placement

Implement the tools in the agent tool system as built-in tools:

- `agent/crates/tools/src/session_search.rs` or similar focused module
- register from `agent/crates/tools/src/registry.rs`
- metadata:
  - `ToolLayer::Observation`
  - `ToolRiskLevel::ReadOnly`
  - `supports_parallel: true`

The tools need a runtime bridge to query desktop canonical session state. Follow the existing tool runtime pattern used by `reach_out`, `reflection`, and `task_operator`: add a session observation runtime capability to `ToolContext` rather than letting the generic tool crate directly open desktop application databases.

Proposed runtime types:

```rust
pub struct SessionObservationRuntime {
    pub search_sessions: SearchSessionsFn,
    pub read_session: ReadSessionFn,
}

pub type SearchSessionsFn = Arc<dyn Fn(SearchSessionsRequest) -> SearchSessionsFuture + Send + Sync>;
pub type ReadSessionFn = Arc<dyn Fn(ReadSessionRequest) -> ReadSessionFuture + Send + Sync>;
```

The desktop runtime supplies implementations backed by canonical session tables. Cloud runner support can either provide the same capability from synced server-side canonical state or omit the capability until the Cloud runner has equivalent access. If the runtime is unavailable, the tools return a clear read-only error: “session observation is unavailable in this runtime.”

### Data source

Use the local canonical database as the source of truth for v1:

- sessions/conversations
- session participants / identities
- message text
- message timestamps / sequence numbers
- stable message ids for follow-up `read_session` calls

The tool must enforce the same session visibility/access rules that the desktop UI uses. It should not expose hidden, deleted, removed, or inaccessible sessions.

### Tool availability

Register both tools for all agent sessions by default when the runtime supports session observation. Do not condition registration on side-by-side UI state.

## Tool: `search_sessions`

### Purpose

Find relevant accessible sessions/conversations and message snippets for a natural-language query.

### Parameters

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Search query for sessions, participants, titles, and message text."
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 20,
      "description": "Maximum number of session results to return. Defaults to 8."
    },
    "includeMessages": {
      "type": "boolean",
      "description": "Whether to include matching message snippets. Defaults to false so search starts as a session-list discovery step."
    }
  },
  "required": ["query"],
  "additionalProperties": false
}
```

### Behavior

1. Trim and validate `query`; empty query returns an error asking for a concrete search query.
2. Search all accessible canonical sessions/conversations.
3. Match against:
   - session title/name
   - session kind/directness where available
   - participant display names
   - message text
   - task or artifact summaries only if they already appear in canonical message/tool metadata exposed to the session read model
4. Rank results with a simple, explainable v1 scoring model:
   - title exact/substring match
   - participant match
   - recent message text match
   - recency as a tie-breaker
5. Return session list results by default; include bounded snippets only when `includeMessages` is explicitly true.

### Result shape

```json
{
  "sessions": [
    {
      "sessionId": "session:...",
      "title": "Launch planning",
      "kind": "group",
      "participants": ["Alice", "Kordi"],
      "updatedAtLabel": "Today 13:04",
      "reason": "Matched participant Alice and 2 recent messages containing 'beta'.",
      "snippets": [
        {
          "messageId": "msg:...",
          "sender": "Alice",
          "text": "We should confirm the beta launch note before Friday.",
          "timeLabel": "13:04"
        }
      ]
    }
  ]
}
```

### Limits

- default result limit: 8 sessions
- max result limit: 20 sessions
- default `includeMessages`: false
- max snippets per session when explicitly requested: 3
- max snippet text: 500 characters
- no raw tool-output dumps in search results; summarize or omit oversized tool outputs

## Tool: `read_session`

### Purpose

Progressively read one accessible session found by `search_sessions` or already known to the model. The default mode returns a message index without message bodies; detailed message text is disclosed only when specific message ids are requested.

### Parameters

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string",
      "description": "Canonical session id to read."
    },
    "aroundMessageId": {
      "type": "string",
      "description": "Optional message id to center the window around."
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 80,
      "description": "Maximum number of messages to return. Defaults to 30."
    },
    "mode": {
      "type": "string",
      "enum": ["index", "messages"],
      "description": "Use index first to list message ids without message text. Use messages with messageIds to disclose selected message bodies. Defaults to index."
    },
    "messageIds": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Message ids to read when mode is messages."
    }
  },
  "required": ["sessionId"],
  "additionalProperties": false
}
```

### Behavior

1. Validate that `sessionId` exists and is accessible to the current user.
2. Default to `mode: "index"`; return message ids, sender, role, sequence number, and time label without message text.
3. In index mode, if `aroundMessageId` is provided, return message index rows before and after that message; otherwise return the latest bounded index window.
4. In `mode: "messages"`, require non-empty `messageIds` and return bodies only for those selected messages in transcript order.
5. Include session metadata and participants.
6. Return message ids so the model can cite or ask for adjacent context with another call.

### Result shape

```json
{
  "session": {
    "sessionId": "session:...",
    "title": "Launch planning",
    "kind": "group",
    "participants": [
      { "name": "Alice", "kind": "human", "role": "participant" },
      { "name": "Kordi", "kind": "agent", "role": "delegate" }
    ]
  },
  "window": {
    "aroundMessageId": "msg:...",
    "hasMoreBefore": true,
    "hasMoreAfter": false
  },
  "messages": [
    {
      "messageId": "msg:...",
      "sender": "Alice",
      "role": "user",
      "sequenceNum": 42,
      "timeLabel": "13:04"
    }
  ]
}
```

### Limits

- default limit: 30 messages
- max limit: 80 messages
- default mode: `index`
- `messages` mode requires explicit `messageIds`
- max message text: 1,200 characters per selected message
- oversized tool outputs should be represented as compact summaries, not full logs

## Security and Access Control

- Tools are read-only and never mutate session state.
- Tools only return sessions visible to the current user under the canonical read model.
- Tools do not reveal raw transport-only ids unless those ids are already visible to the user in normal session context.
- Deleted/hidden/removed sessions and messages are excluded.
- If access cannot be determined, deny by default.
- Tool results should avoid leaking local file paths except paths already visible in user-facing artifact/message context.

## Prompt and Agent Behavior

Do not add a special co-pilot prompt. Do not describe the side-panel agent as a special private assistant.

The base agent tool list and tool descriptions are sufficient to tell the model that it can search/read sessions. Tool descriptions should also guide progressive disclosure: search session list first, read a message index next, then request detailed bodies only for selected `messageIds`. Tool descriptions should be clear and neutral:

- `search_sessions`: “Search accessible sessions and conversations for relevant prior chats. Use first to find session ids.”
- `read_session`: “Progressively read a session: first a message index, then selected message details by messageIds.”

If later product work wants the model to cite session/message ids consistently, add that as a general tool-result formatting convention or general agent instruction, not as a side-panel-only prompt.

## UI Implications for PR #534

Before PR #534 is finalized, revise the side-panel copy to align with this spec:

- Replace “Ask co-pilot” with “Ask agent” or “Open side session.”
- Replace “Co-pilot · {sessionName}” with the actual side session name or “Side session · {sessionName}.”
- Remove “Private helper for this chat.”
- Remove `data-chat-copilot-scope="private"` unless it is renamed to neutral layout/test terminology.
- Keep explicit open behavior. Do not auto-open side sessions when a candidate exists.
- Keep slash-trigger behavior only if the command name is neutral enough. `/ask` is acceptable; `/copilot` should be reconsidered because it implies a special agent mode.

## Testing Plan

### Unit tests

- Tool metadata classifies `search_sessions` and `read_session` as Observation / ReadOnly / parallel.
- `search_sessions` rejects empty queries.
- `search_sessions` returns title, participant, and message matches.
- `search_sessions` respects result and snippet limits.
- `read_session` rejects inaccessible or missing sessions.
- `read_session` returns recent messages when no anchor is supplied.
- `read_session` returns an anchored window when `aroundMessageId` is supplied.
- Oversized message/tool content is truncated or summarized.

### Desktop integration tests

- A local agent session can call `search_sessions` through the tool runtime.
- A side-by-side agent session has the same tool availability as a normal agent session.
- Cloud-synced canonical sessions appear in results through the local DB path.
- Hidden/deleted/inaccessible sessions are not returned.

### Regression tests for PR #534 semantics

- Side panel does not auto-open from candidate sessions.
- Side panel UI copy does not claim a special co-pilot/private agent mode.
- Main chat slash text is not sent when a local UI slash trigger opens a side session.

## Rollout

1. Land this spec.
2. Update PR #534 copy and semantics so the side panel is a normal side session UI.
3. Implement `search_sessions` and `read_session` as general Observation tools.
4. Wire desktop canonical DB runtime implementations.
5. Verify normal agent sessions and side-by-side sessions see the same tool set.
6. Later, improve ranking with full-text search or embeddings if simple DB search is insufficient.

## Non-goals for v1

- No live Cloud fetch during tool execution.
- No embeddings/vector search requirement.
- No special co-pilot prompt or agent role.
- No write tools for sessions.
- No cross-account data access.
- No artifact/task-specific tools unless their summaries are already visible through canonical messages.

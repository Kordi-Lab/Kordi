# Canonical session model

Kordi sessions are local-first. Each desktop profile owns a canonical session database under its own Kordi storage root. The bridge/server relays and coordinates messages, but it is not the source of truth for a user's session history.

## Invariants

1. **Session is the center**
   - Local agent chats, person chats, external-agent chats, and `@` participation all render from canonical sessions.
   - Bridge conversations and runtime sessions are transport/source records, not primary UX sessions.

2. **Local-first per profile**
   - Every local user/profile has isolated auth, avatar/profile state, canonical session DB, bridge config/secrets/identities, and context/cache metadata.
   - Remote participants store their own local copy when they receive or participate in a session.

3. **Canonical identity drives avatars and participants**
   - Human identity key: `human:<humanId>`.
   - Agent identity key: `agent:<agentId>`.
   - Bridge node IDs are fallback identity keys only when human/agent IDs are missing.
   - Components must not derive avatars from display names, session IDs, project IDs, or random localStorage seeds when a canonical identity exists.

4. **`@` is the product surface for participation**
   - Users involve people/agents with `@Person` / `@Agent` inside the current session.
   - Owned agents can also involve people/agents through the same participation model.
   - Agent-authored `@` is rendered as normal agent participation, for example Alice's Kordi can say it is involving `@Bob's Kordi`, then Bob's Kordi replies as a normal agent turn in the same transcript.
   - `reach_out` may remain internal executor plumbing, but it is not the user-facing concept.

5. **Remote responses stay in the parent session**
   - Delegated/remote responses render inline using the same transcript UI as native agent responses.
   - Persistent delegated exchanges are child trace/audit records, not unrelated top-level sessions.

6. **Person + default agent dedupe**
   - If Bob and Bob's default agent are in the same logical relationship, the session list shows one session.
   - Messages still preserve exact sender identity: Bob vs Bob's Kordi.

7. **Stable session identity and default naming**
   - Every canonical session has a stable `session.id`; UI, projects, bridge transport records, delegated exchanges, messages, context snapshots, and KV/cache rows must join/reference sessions by this ID, not by title or display name.
   - Session titles are user-facing labels only and can be renamed without breaking references.
   - When creating a new session without an explicit title, the default title is the first receiver's display name, e.g. opening a chat to Bob creates a session titled `Bob`; opening a chat to Bob's Kordi creates a session titled `Bob's Kordi`.
   - For relationship sessions, the first receiver/person name is preferred over that person's default agent so Bob + Bob's Kordi appears as one session titled `Bob`.

## Database

The first implementation lands an additive local SQLite database:

```text
<KORDI_STORAGE_ROOT>/canonical-sessions.sqlite3
```

Tables:

- `local_profile`
- `identities`
- `sessions`
- `session_participants`
- `session_messages`
- `delegated_exchanges`
- `presence`
- `context_snapshots`
- `kv_cache_entries`

Identity rules:

- Every human and agent is an `identities` row with a canonical `identities.id` used by sessions, messages, participants, presence, delegated exchanges, context snapshots, and caches.
- Agents must also have a stable `agent_id`. For local agents this is profile/workspace scoped (`local:<hash(profile_id|workspace_root)>`); for bridge agents it is the bridge-advertised agent id.
- Agent display uses the delegate-facing agent name (`delegateAgentName`, currently `Kordi` for the built-in local agent), not the source/worktree/project folder name.
- Agent ownership is explicit: `owner_identity_id` points at the owning human identity. UI participant cards should render that owner, e.g. `Kordi` with `Owner: You`.
- Runtime/source labels such as workspace folder names are stored only as metadata (`runtimeLabel`, `workspaceRoot`) and must not become the canonical visible agent name.
- Direct person sessions contain human participants only by default. Local/default agents must not auto-join; an agent becomes a session participant only for self-agent/direct-agent sessions or when explicitly involved through `@Agent`/delegation.

The existing local runtime session DB and bridge conversation DB remain temporarily as transport/source stores while canonical reads/writes are introduced in phases.

Desktop runtime project membership uses the local runtime session DB fields `sessions.session_scope = 'project'` and `sessions.project_root`. A session can belong to one project; moving/creating a project session updates those fields and resumes the runtime from `project_root` so all sessions under the project load the same project settings, prompts, shared sources, and filesystem context. Empty projects are persisted separately in the runtime session DB `projects` registry (`project_id`, `root`, `name`, timestamps, `archived_at`) so creating a project from the Projects `+` menu does not have to create a blank session row.

All session-linked tables use `session_id` as the durable join key. Project joins, delegated exchanges, bridge/audit records, and cache/context rows should connect to the canonical DB by `session_id`; they must not depend on mutable titles.

Current additive sync behavior:

- Desktop local chat sessions mirror into canonical `sessions` using the existing runtime session ID as canonical `session.id`.
- Desktop local chat messages mirror into canonical `session_messages` with source transport `desktop-chat` and deterministic source event IDs.
- Bridge conversations expose `canonicalSessionId` and mirror into canonical `sessions` using `session:bridge:<bridgeConversationId>`.
- Bridge messages mirror into canonical `session_messages` with source transport `desktop-bridge` and source event IDs based on the bridge conversation/message IDs.
- Bridge outreach records with a `parentSessionId` mirror as canonical `delegated_exchanges` under the parent session instead of becoming canonical top-level sessions.
- Outreach parent mirroring adds the selected **B · Join event** status message, then mirrors remote person/agent responses into the parent session with source transport `desktop-bridge-outreach`.
- Sync is idempotent: source transport/event IDs dedupe repeated local-first imports.

## Context and KV cache

Context/cache state is scoped by local profile, session, agent identity, model/provider, prompt hash, participant hash, and message/context hashes. Cache entries must not leak across users, profiles, bridge identities, agents, or sessions.

`@Person` / `@Agent` bridge outreach currently persists a `context_snapshots` row for the policy-scoped context sent with the delegation, keyed by local profile, parent session, initiating agent/human identity, target participant hash, prompt hash, and message/context-range hash.

Invalidation triggers include new/edited/deleted messages, participant changes, delegated exchanges, project context changes, prompt/model/provider changes, and identity/profile changes.

## UI component design

Canonical sessions need canonical UI components so identities, avatars, participants, delegated exchanges, and presence render consistently. Delegation should change metadata and participant state, not introduce a separate visual language.

Selected delegation UI: **B · Join event**. Keep the original Kordi chat UI almost unchanged. Add one subtle centered join/request event when a person or agent is involved through `@`, then render the response with the existing message components.

Planned components:

- `SessionList`: left-side canonical session list. Shows only top-level canonical sessions and hides child delegated exchanges. It displays the session title, but opens/routes by canonical `session.id`.
- `NewSessionButton`: Chat `+` entry point. Opens an own-agent draft immediately in the UI, but does not materialize a durable session until the first meaningful write.
- `OwnedAgentPicker`: popover for choosing which owned agent starts a self-agent session.
- `ContactMessageButton`: opens/resumes canonical sessions for people, owned agents, or external agents through the canonical resolver.
- `SessionTranscript`: renders canonical messages from the canonical DB, with delegation metadata attached to the relevant turns.
- `AgentTurnMessage`: shared native-style agent response component for local agents, remote agents, and delegated `@Agent` responses.
- `DelegationDetailsPopover` / `DelegationTraceDisclosure`: optional collapsed details for request id, initiator, target, context policy, timing, status, and transport/audit trace.
- `MentionComposer`: canonical `@` resolver grouped by people, my agents, and other users' agents.
- `SessionRightPanel`: active-session participant graph, presence/status, delegated exchanges, and context.
- `ParticipantCard`: canonical identity row/card with owner relationship and presence.
- `PresenceBadge`: shared user/agent/message/session status badge.

Component rules:

- Do not redesign the shell, session rail, chat header, composer, right rail, message bubble shape, or `LiveChatTurnCard` layout for delegation.
- Add the smallest new transcript surface possible: a centered join/request event using the existing compact system-message style.
- Blank local chat drafts are transient UI state. They do not receive durable local/canonical session rows, and they disappear if abandoned.
- Components receive canonical identities or canonical avatar keys; they should not derive avatars from display names, session IDs, project IDs, or raw conversation IDs.
- Local and remote agent responses use the same `AgentTurnMessage` UI, including thinking sections, tool sections, final-answer bubble, status, and error states.
- User-authored and agent-authored `@` delegated responses appear inline in `SessionTranscript` as normal person/agent messages.
- Agent-authored `@Person` shows the target's response as a normal person bubble; it must not show a fake agent `Replying…` state.
- Agent-authored `@Agent` shows the target's response as a normal `AgentTurnMessage`, including thinking/tool timeline when available.
- Delegation trace is secondary and collapsed by default.
- The right panel is not a second chat list; it explains the selected session's participant graph and linked exchanges.

Join event examples:

- User `@Agent`: `Bob's Kordi joined through Alice's @ mention` → Bob's Kordi replies with existing `AgentTurnMessage`.
- Agent `@User`: `Bob was involved by Alice's Kordi` → Bob replies with an existing person bubble; Alice's Kordi can then synthesize.
- Agent `@Agent`: `Bob's Kordi joined through Alice's Kordi` → Bob's Kordi replies with existing `AgentTurnMessage`, including thinking/tool timeline.

Migration order:

1. Add `useCanonicalSessionViewModels()` behind a feature flag.
2. Build canonical components without deleting legacy UI paths.
3. Route Contact Message and Chat `+` into canonical sessions by `session.id`; default unnamed sessions to the first receiver's display name.
4. Keep blank drafts ephemeral until first real content; only then materialize the runtime/local/canonical session row.
5. Mirror local/bridge messages into canonical DB and render via `SessionTranscript`. Backend mirroring is in place; UI read-model migration remains.
6. Replace old chat/session rails with `SessionList`.
7. Replace outreach thread cards with normal transcript turns plus optional inline/right-panel delegation trace details.
8. Add agent-authored `@` rendering: local agent turn shows the mention/invocation, remote participant replies as a normal message in the same session.
9. Remove legacy bridge/local session merge UI after canonical UI is stable.

## Migration direction

1. Add canonical DB and repository layer.
2. Add identity resolver and avatar canonicalization.
3. Route Contact Message and Chat `+` through canonical session resolver.
4. Mirror local agent and bridge messages into canonical session messages.
5. Convert `@` involvement into delegated exchanges that render inline in the parent session.
6. Backfill old local sessions, bridge conversations, and outreach records.
7. Stop rendering the primary session list from legacy local/bridge session stores.

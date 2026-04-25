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
   - `reach_out` may remain internal executor plumbing, but it is not the user-facing concept.

5. **Remote responses stay in the parent session**
   - Delegated/remote responses render inline using the same transcript UI as native agent responses.
   - Persistent delegated exchanges are child trace/audit records, not unrelated top-level sessions.

6. **Person + default agent dedupe**
   - If Bob and Bob's default agent are in the same logical relationship, the session list shows one session.
   - Messages still preserve exact sender identity: Bob vs Bob's Kordi.

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

The existing local runtime session DB and bridge conversation DB remain temporarily as transport/source stores while canonical reads/writes are introduced in phases.

## Context and KV cache

Context/cache state is scoped by local profile, session, agent identity, model/provider, prompt hash, participant hash, and message/context hashes. Cache entries must not leak across users, profiles, bridge identities, agents, or sessions.

Invalidation triggers include new/edited/deleted messages, participant changes, delegated exchanges, project context changes, prompt/model/provider changes, and identity/profile changes.

## Migration direction

1. Add canonical DB and repository layer.
2. Add identity resolver and avatar canonicalization.
3. Route Contact Message and Chat `+` through canonical session resolver.
4. Mirror local agent and bridge messages into canonical session messages.
5. Convert `@` involvement into delegated exchanges that render inline in the parent session.
6. Backfill old local sessions, bridge conversations, and outreach records.
7. Stop rendering the primary session list from legacy local/bridge session stores.

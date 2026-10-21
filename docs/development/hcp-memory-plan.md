# Organizing Kordi memory along the Human Context Protocol

Status: proposal, 2026-10-21. Tracks
[#1977](https://github.com/Kordi-Lab/Kordi/issues/1977). Builds on
[issue-1710-memory-controls.md](issue-1710-memory-controls.md) and
[../common-ground.md](../common-ground.md).

## Summary

Kordi holds what it knows about a person in four places with four consent
models: account memories, common ground profile cards, account profile
fields, and connector grants. Nothing records which kind of information a
memory is, who declared it, or which readers may see it, and agent reads are
not logged. The Human Context Protocol (HCP, Stanford HAI and the Loyal
Agents project) defines exactly those three things: a category on every
entry that doubles as the unit of access, a declaration type that separates
what the person said from what a model inferred, and category-scoped,
revocable grants with a person-readable audit log.

This plan adopts the HCP model inside the existing stores. It does not add a
new service, does not rename product copy ("memory" stays), and does not
implement OAuth or verifiable credentials. HCP permits a first-party-only
implementation to be conformant without OAuth, which is Kordi's posture.

References: the Stanford project page
(digitaleconomy.stanford.edu/project/loyal-agents/hcp-human-context-protocol),
hcp.me, and the ICML 2026 position paper "Robust AI Personalization Will
Require a Human Context Protocol". This document describes the HCP model in
its own words; field and tool names follow the public HCP material.

| PR | Scope | Depends on |
|---|---|---|
| 0 | This document | nothing |
| 1 | Server schema: category, declaration type, confidence, status, versions, provenance, audit table; `memoryVersion` 2 | nothing |
| 2 | Harness tools: `memory_add`, `memory_update`, `memory_delete`, `memory_search`; conflict quarantine on save | 1 |
| 3 | Grants: `cloud_context_grants`, default grants on upgrade, reader resolution for every memory read, revoke and list routes | 1 |
| 4 | Search and minimization: embeddings, search route, relevance ordering, read audit events, bootstrap block built from search | 1, 3 |
| 5 | Desktop "Your context" page and iPhone screen: memories by category, needs review, access list, activity | 1, 3, 4 |
| 6 | Export in the HCP envelope, local MCP server for other agents on the Mac, discovery document | 1, 3 |
| 7 | Documentation, deletion register entries (#1685), privacy page (#1682) | 1 to 6 |

## Current state, verified on `main` (90dcdad27)

- `cloud_account_memories` (migrations 0119 to 0121) has `scope`
  (`global`, `conversation`, `group`, `project`), `scope_id`, `scope_label`,
  `source` (`user_correction`, `repeated_failure`, `outcome`, `manual`),
  `text`, timestamps and `archived_at`. Settings are `memory_enabled` and
  `exclude_sensitive`. Routes are list, save, update, delete, forget all, and
  settings under `/v1/cloud/memory`; the runner reads and saves through
  `cloud_agent_runtime/routes/runner_memory.rs` while it holds the lease.
  Every write is audited through `write_audit`; no read is.
- The `reflection` tool (`agent/crates/tools/src/reflection_tool.rs`) takes
  `scope`, `scopeId`, `source`, `lesson`. Scope writes are limited by
  `memory_remote/allowed_scopes.rs`; `allow_global` is false for shared
  requests. The text guard (`agent/crates/tools/src/memory_guard.rs`) rejects
  health, financial, credential and relationship keywords when
  `exclude_sensitive` is on, and rejects twelve-word quotes of members who
  turned off AI use.
- The prompt inlines every readable memory (`session_bootstrap/memory.rs`)
  in Global, This conversation, This project and This group blocks, newest
  first, capped at 40 memories and 8000 characters, with a disclosure rule
  that the owner's memories are never revealed to others. Group memories are
  co-owned by the group (`memory_store/groups.rs`).
- Common ground (`common_ground/`, migrations 0134 to 0143) keeps one card
  per profile (`cloud_common_ground_cards` keyed by `profile_id`) with
  `topics_json`, `evidence_json`, `hidden_json`, `sharing_enabled`, and
  `revision`. Profiles have a `kind` of `work`, `health`, `daily` or
  `custom`. A room or pairing shares exactly one profile; rooms expire 24
  hours after the last join.
- Connectors (`connectors/`, migrations 0114 to 0117) keep per-connector
  `read_scopes` and `act_scopes`, per-agent grants in
  `cloud_connector_agent_grants`, and the audience rule in
  `connectors/audience.rs`: connector tools reach a run only when the owner
  sent the message in their own private agent conversation.
- Account profile fields (`about`, location, time zone, website, birthday,
  migrations 0140 and 0141) are edited by the person only.
- Capabilities advertise `memoryVersion: 1`, `commonGroundVersion: 2`,
  `connectorsVersion`, `contactProfileVersion: 1`. Clients hide a section
  without its flag.
- The maintainability ratchet refuses new files of 500 lines or more and
  growth of existing ones at that size. Upgrade tests snapshot
  `to_jsonb(cloud_accounts)`; any new accounts column must be subtracted in
  the after-query. Migrations continue from 0144.

## How Kordi maps onto HCP

| HCP concept | Kordi today | Plan |
|---|---|---|
| Entry with natural-language preference | memory `text` | unchanged |
| Category (unit of access) | none | new `category` column, nine registered slugs plus `hcp-custom:` |
| Dimension (conflict key within a category) | none | new nullable `dimension`, normalized |
| Declaration type | implied by `source` (`manual` means the person) | explicit `declaration_type` |
| Confidence on inferred entries | none | `confidence`, required when model-inferred |
| Status and version history | `archived_at` | `status`, `version`, `previous_version`, versions table |
| Provenance (source, captured by, user verified) | `scope`, `scope_id`, `source` | kept, plus `captured_by` and `user_verified` |
| Grants scoped to categories | memory switch, `allow_global`, connector audience, profile sharing | one `cloud_context_grants` table consulted on every read |
| Temporary grant with absolute expiry | room sharing expires with the room | recorded as a grant row |
| Persistent grant by separate affirmative act | pairing, "Share my card", memory switch | recorded as grant rows, revocable |
| Search with query, categories, purpose, cap of 20 | full prompt dump | search route and tool; bootstrap block built from it |
| Relevance ordering declared | newest first | semantic via the embedding service, lexical fallback |
| Provenance redacted from agents | not applicable | search responses to agent actors omit `captured_by` and the conversation source |
| Conflict quarantine (person beats model) | none | `conflicted` status, hidden from agents, shown to the person |
| Person-readable audit log including reads | writes only, in `cloud_audit_events` | `cloud_context_audit`, filterable, exportable, never readable by agents |
| User-only export | none | JSON-LD export in the HCP envelope |
| Natural-language access | "forget everything" button only | agent may show, correct and forget on request with a confirmation line |
| MCP tools | none | local MCP server on the Mac, first-party profile |

Three things in Kordi are not HCP concepts and stay as they are:

- **Scope** (`global`, `conversation`, `group`, `project`) says where a
  memory applies, not what kind it is. It remains the write restriction and
  the prompt grouping. In the export it travels as provenance and metadata.
- **Group memories** are co-owned by the group. The grant model covers the
  owner's own memories reaching other readers; group memories are already
  shared by construction and keep the membership rule in
  `memory_store/groups.rs`.
- **Common ground cards** are rebuilt from sources and keyed by revision.
  They are not moved into the memories table. The "Your context" page and
  the export read both stores; a topic becomes an entry whose category comes
  from the profile kind (work to `work_context`, health to `health_context`,
  daily to `coordination_context`, custom to `hcp-custom:profile_<slug>`),
  declared as model-inferred, with the card's evidence as provenance.

## Decisions

- **Categories.** The nine registered HCP slugs: `general_preferences`,
  `goals_and_constraints`, `health_context`, `education_learner_profile`,
  `work_context`, `purchase_history_preferences`, `values_and_ethics`,
  `location_context`, `coordination_context`. Kordi adds one custom slug,
  `hcp-custom:task_lessons`, for agent operating notes saved from repeated
  failures and outcomes, which describe how to do a task rather than the
  person. The agent picks the category when it saves; the default is
  `general_preferences`. Backfill maps `source = 'repeated_failure'` and
  `'outcome'` to `hcp-custom:task_lessons`, everything else to
  `general_preferences`.
- **Declaration type.** `user-declared` when the person typed or edited the
  memory in settings, or confirmed one; `model-inferred` for every agent
  save; `issuer-attested` reserved for connector-derived facts (not written
  in this plan). Backfill: `source = 'manual'` is user-declared, the rest
  model-inferred with confidence `medium`.
- **Conflicts.** On any save or edit, an active user-declared entry and a
  model-inferred entry with the same account, category and normalized
  dimension conflict. The model-inferred one gets `status = 'conflicted'`,
  is left out of every agent read, and appears under "Needs your review" in
  settings with Keep and Discard. Keep turns it into a user-declared active
  entry and marks the older one deprecated. Entries without a dimension are
  compared by the existing normalized-text dedup only.
- **Sensitive memories.** Today the keyword guard rejects four lists
  outright: health, financial details, credentials, and relationship or
  identity details. Under the grant model the health list becomes a router:
  matching text is saved in `health_context`, which no reader other than
  the owner's private agent ever holds a grant for, and which the owner's
  own agent may write only when `exclude_sensitive` is off. The financial,
  credential and relationship lists stay a hard rejection: account numbers
  and secrets are not preferences, and HCP v1 has no registered category
  for family or relationship context yet. `exclude_sensitive` keeps its
  copy and now means "do not save health, values or location memories".
- **Grants.** `cloud_context_grants` rows have `grant_id`, `account_id`,
  `client_kind` (`own_agent`, `group`, `contact`, `room`, `digest`,
  `external_mcp`), `client_id`, `client_name`, `scopes` (text array of
  `hcp:<category>:read|write`), `restrictions` (JSON, for example
  `{"profileId": ...}` or `{"scopeIds": [...]}`), `grant_type`
  (`temporary`, `persistent`), `grantor` (null unless someone else
  authorized), `issued_at`, `expires_at`, `revoked_at`, `status`. A
  reader's effective categories are the intersection of its active grants'
  scopes and restrictions. Revocation is immediate and never rate-limited.
  Connector grants stay in their own table and are listed on the same page.
- **Default grants on upgrade**, written once by the migration so that no
  behaviour changes on day one:
  - `own_agent`, persistent: read and write on every category except
    `health_context`, `values_and_ethics` and `location_context` while
    `exclude_sensitive` is on. Turning the memory switch off suspends the
    grant; turning it on restores it. This is the one persistent grant that
    is elected by the existing switch, whose copy already says what it does.
  - `group`, temporary per shared run: runs whose audience is shared get
    read on `general_preferences`, `goals_and_constraints` and
    `coordination_context` only, restricted to the group's scope ids, and
    never on health, values or location. This replaces the current rule
    that a shared run reads the owner's global memories in full and makes
    the disclosure rule enforceable rather than prompted.
  - `room`, temporary: one row per room membership, restricted to the shared
    profile, expiring when the room closes. `contact`, persistent: one row
    per pairing, restricted to the shared profile; revoking it ends the
    pairing. Both only make existing behaviour visible and revocable.
  - `digest`: read on the same categories as `own_agent`.
- **Search and minimization.** `POST /v1/cloud/memory/search` takes
  `query`, `categories`, `purpose`, `maxEntries` (default 5, ceiling 20)
  and `responseDetail` (`full` or `minimal`). Ordering is semantic using the
  Qwen3 embedding service already used by common ground, with a Postgres
  full-text fallback when the service is unavailable; the response names
  the method used. Responses to agent actors omit `captured_by` and the
  conversation id in `scope_id`; the person's own requests are not
  redacted. The route is not paginated. The session bootstrap block is
  assembled through the same function with the conversation title and last
  message as the query, so the prompt stays within 20 ordered entries and
  one read event per turn is logged with the purpose "session bootstrap".
  The on-demand `memory_search` tool covers everything else.
- **Tools.** `memory_add` (category, dimension, confidence, scope, scopeId,
  text), `memory_update` (memoryId, text, reason), `memory_delete`
  (memoryId, reason; soft delete only), `memory_search` (query, categories,
  purpose, maxEntries). Every agent save is model-inferred; the tool
  description says so and asks for a confidence. `reflection` stays as an
  alias of `memory_add` for one release so the TUI and old prompts keep
  working. Hard deletion and grant revocation are settings actions only.
- **Audit.** `cloud_context_audit` with `event_id`, `account_id`,
  `event_type`, `actor_type` (`user`, `agent`, `system`), `actor_id`,
  `memory_id`, `related_memory_id`, `category`, `purpose`, `grant_id`,
  `detail`, `created_at`. Event types: created, read, updated, deleted,
  hard deleted, exported, grant issued, grant revoked, grant expired,
  conflict detected, conflict resolved. Rows are inserted synchronously in
  the same transaction as the write; reads insert one row per search. No
  route exposes it to a runner. Existing `write_audit` calls remain for
  account-level actions.
- **Versions.** `cloud_account_memory_versions` keeps `memory_id`,
  `version`, `text`, `category`, `dimension`, `declaration_type`,
  `actor_type`, `actor_id`, `created_at`. Each edit increments `version`
  and sets `previous_version`; the memory id never changes.
- **Export.** `GET /v1/cloud/memory/export` returns a JSON-LD document of
  HCP entries in the grouped envelope: every memory not hard-deleted
  (status included), card topics per profile, and the profile fields as
  user-declared entries. Query flags include versions and the audit log,
  and exclude deleted. The call is person-only and logged. Import is a
  follow-up; when it lands it must not reinstate deleted entries or
  silently change categories.
- **MCP.** The desktop sidecar gains a local MCP server, `kordi mcp
  context`, exposing `hcp_searchPreferences`, `hcp_addPreference`,
  `hcp_updatePreference` and `hcp_deletePreference` backed by the account
  routes. Each external client (Claude Code, Codex, a local coding agent)
  approves in the Kordi app and becomes an `external_mcp` grant: temporary
  for 24 hours by default, persistent only through a separate switch whose
  copy says access stays until revoked. kordi.ai publishes
  `/.well-known/hcp-configuration` declaring the first-party authorization
  profile, the categories, `mcp` and `rest` transports, and the
  minimization method. OAuth waits until a client Kordi does not operate
  needs it.
- **Capability.** `memoryVersion` becomes 2 when PRs 1, 3 and 4 are on a
  server. Clients on 1 keep today's Memory tab; clients on 2 show the "Your
  context" page. The desktop preview flag pattern from #1710 applies for
  the UI PR.
- **Signed-out Mac.** The local `reflection-lessons/<scope>/<scope-id>.md`
  cache gains category and declaration type in each line's bracket
  (`- <timestamp> [<source>|<category>|<declaration>] <text>`); the parser
  accepts the old form. Uploads at sign-in carry the new fields.

## PRs

### PR 1: server schema

- Migration `0144_memory_context.sql`: add `category`, `dimension`,
  `declaration_type`, `confidence`, `status`, `version`,
  `previous_version`, `captured_by`, `user_verified` with the checks above
  and the backfill; create `cloud_account_memory_versions` and
  `cloud_context_audit`; index `(owner_account_id, category, status)` and
  a unique partial index on `(owner_account_id, category, dimension)` for
  active user-declared rows.
- `memory_store/types.rs` and the handlers carry the new fields; `save`
  runs the conflict check inside the scope lock; `update` writes a version
  row; delete sets `status = 'deleted'` and keeps `archived_at` in step.
- Audit writes for every event type; `memoryVersion` stays 1 until PR 4.
- Database tests in `scripts/test-cloud-migrations.sh`; upgrade tests.

### PR 2: harness tools

- `agent/crates/tools/src/memory_tools/` (one file per tool, each under
  500 lines) replaces `reflection_tool.rs`, which becomes the alias.
- `reflection_runtime.rs` and `memory_remote/` send category, dimension,
  confidence; the local cache format and parser change as above.
- Prompt section wording: name the categories, say that agent saves are
  inferred and the person's edits win, keep the disclosure rule.
- The sensitive guard routes health, values and location text to their
  categories instead of rejecting it, subject to the grant check.

### PR 3: grants

- Migration `0145_context_grants.sql` and the default grant rows.
- `context_grants.rs` in the cloud server: resolve a reader to effective
  categories; used by list, search, the runner routes, common ground card
  reads and the digest input. `connectors/audience.rs` stays for connector
  tools; shared-run memory reads go through the group grant instead of
  the current full read.
- Routes: `GET /v1/cloud/memory/grants`, `DELETE
  /v1/cloud/memory/grants/{grant_id}`; room join, room leave, pairing
  redeem and card sharing write and close their grant rows.
- Grant expiry: the expired event is written on the first read that
  presents an expired grant, or by the existing digest sweep within 24
  hours.

### PR 4: search and minimization

- `embedding` column (pgvector) on memories, filled on save by the
  embedding client lifted out of `common_ground/`; lexical fallback.
- `POST /v1/cloud/memory/search` and the runner equivalent; `memory_search`
  tool wired in the harness; bootstrap block assembled from search; read
  audit rows; `memoryVersion: 2`.

### PR 5: Your context (desktop and iPhone)

- Desktop: `features/context/` with a page replacing the Memory tab in
  `CloudAccountSettingsDialog`: Memories (filter by category, scope,
  declared by; edit, delete), Needs review (conflicted entries, Keep and
  Discard), Profiles (link to common ground), Access (grant rows and
  connector agents, Revoke), Activity (audit list with filters and
  export). Flat settings style, title and at most one line of copy, no
  uppercase headings.
- iPhone: the same as a flat Settings sheet; `CloudMemory.swift` gains the
  new fields and routes.
- Loopback design preview under `docs/design-previews/your-context/` for
  approval before the React and Swift work.

### PR 6: export and MCP

- Export route and the JSON-LD mapping (memories, card topics, profile
  fields).
- `kordi mcp context` in the sidecar, approval sheet in the app, the
  `external_mcp` grant flow, and the discovery document served by the
  cloud server.

### PR 7: documentation

- `docs/memory.md` describes categories, declaration types, grants, the
  audit log and export; deletion register entries for memories, versions,
  audit and grants; privacy page link.

## Open questions for the owner

1. Health memories: allow the owner's private agent to save them when
   `exclude_sensitive` is off (recommended, since no other reader can ever
   hold a health grant), or keep rejecting them outright.
2. Group runs: cut shared runs down to the three low-sensitivity categories
   by default (recommended), or keep reading the owner's global memories in
   full as today.
3. Pairings: make revoking the contact grant end the pairing (recommended),
   or keep pairings permanent.
4. Whether PR 5 ships behind a preview flag first, as #1710 did.

## Not in this plan

Tier 2 verifiable credentials, JSON-LD processing beyond a constant
context string, OAuth flows, guardian or multi-party consent, import of
another provider's export, and moving common ground topics into the memory
table. Each is either deferred by HCP v1 itself or not needed for a
first-party implementation.

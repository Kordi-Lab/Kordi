# Agent-logged memories: where each one goes

Status: proposal, 2026-10-22, for owner review before any code. First
implementation slice of [#1977](https://github.com/Kordi-Lab/Kordi/issues/1977)
(Human Context Protocol for Kordi memory). Builds on
[hcp-memory-plan.md](hcp-memory-plan.md),
[issue-1710-memory-controls.md](issue-1710-memory-controls.md) and
[../common-ground.md](../common-ground.md). Also closes the "isolation in
the agent" bullet of [#1971](https://github.com/Kordi-Lab/Kordi/issues/1971).

## The use case

An agent saves a memory while it chats (the `reflection` tool). Today it
picks one of four scopes and stores one flat line of text. The owner wants
each agent-logged memory filed where it belongs:

| What the agent learned | Where it should go | Who reads it |
|---|---|---|
| Something about the person (their work, health habits, daily life, preferences) | The matching Grounding profile: **Work**, **Health**, **Daily tasks** (custom profiles by explicit choice) | The owner, the owner's agent, and that profile's card after a rebuild |
| Something about this chat only (a correction, a convention for this task) | **This conversation** | The owner's agent in this chat |
| Something the group shares (a decision, who does what, how the group works) | **This group** | Every member and every member's agent |
| A preference that applies everywhere ("from now on", "always") | **Global** (unchanged) | The owner's agent everywhere |
| How to do a task (a repeated failure, an outcome) | Conversation or project, tagged as a task note (unchanged scope rules) | The owner's agent |

The plan adds two fields to every memory, an HCP **category** and a
**declaration type**, and uses the category to route a memory to a profile.
Scope keeps its meaning (where the agent reads the memory); the category says
what kind of information it is. Product copy keeps saying "memory".

## Current state, verified on `main` (d57806cea, 2026-10-22)

- `cloud_account_memories` (migrations 0119 to 0121) has `scope`
  (`global`, `conversation`, `group`, `project`), `scope_id`, `scope_label`,
  `source` (`user_correction`, `repeated_failure`, `outcome`, `manual`),
  `text`, timestamps, `archived_at`. Nothing records what kind of
  information a memory is or whether the person or the agent declared it.
  Migrations now end at 0146, so the numbers in `hcp-memory-plan.md`
  (0144, 0145) are taken; the next free number is 0147.
- The `reflection` tool (`agent/crates/tools/src/reflection_tool.rs`) takes
  `scope`, `scopeId`, `source`, `lesson`. The Mac enforces allowed scopes
  per turn (`memory_remote/allowed_scopes.rs`); cloud runs enforce them in
  `memory_store/runs.rs` (`check_save_scope`). The only routing guidance the
  model gets is one sentence in the `## Memories` section: global for
  "always", everything else in its conversation, group or project scope.
- A Grounding profile (`cloud_common_ground_profiles`, kinds `work`,
  `health`, `daily`, `custom`) has one card built by a model run from the
  sources the owner turned on. The **Memory** source
  (`common_ground/build/gather.rs`) reads the owner's own memories in every
  scope, up to 200, newest first, for every profile alike; the profile's
  lens prompt (`common_ground/prompt.rs`) is what keeps work out of the
  health card. A memory reaches a card only when the owner rebuilds it
  ("Rebuild from memory" on the card page). Topics cite evidence; a cited
  memory shows as a reference with source "Memory".
- The keyword guard (`agent/crates/tools/src/memory_guard.rs`) rejects
  diagnosis-level health terms, financial details, credentials and
  relationship or identity terms when "Keep sensitive details out of
  memories" is on. Fitness and wellbeing text ("runs 5k on Tuesdays") passes
  it, which is exactly what the Health profile lens keeps.
- Group memories are co-owned by the group and always pass the sensitive
  guard; the group info page lists them on both apps. Conversation and
  project memories show on the chat's Memory tab; global ones in account
  settings.
- Capabilities: `memoryVersion: 1`, `commonGroundVersion: 2`.
- The maintainability ratchet refuses new files of 500 lines or more and
  growth of existing ones at that size. Files this plan touches are close:
  `memory_store.rs` 402, `reflection_runtime.rs` 454,
  `session_bootstrap/memory.rs` 454. New logic goes in new files.

## Design

### The routing key: one category per memory

Every memory carries one HCP category. The agent picks it when it saves;
the person can change it. The category decides the profile:

| Category | Means | Profile |
|---|---|---|
| `work_context` | projects, fields, skills, collaborations, tools | Work |
| `education_learner_profile` | what the person is learning, courses, how they learn | Work |
| `health_context` | sport, exercise, sleep, diet, wellbeing routines and goals | Health |
| `coordination_context` | schedules, availability, time zones, routines | every fixed-kind profile |
| `location_context` | where the person usually is, local plans | Daily tasks |
| `purchase_history_preferences` | shopping and household preferences | Daily tasks |
| `general_preferences` | how to answer: language, tone, format, length | none (prompt only) |
| `goals_and_constraints` | objectives, deadlines, limits | none (prompt only) |
| `values_and_ethics` | what the person cares about | none (prompt only) |
| `hcp-custom:task_lessons` | how to do a task: repeated failures, outcomes | none (prompt only) |

Rules:

- A memory with no category from an old client gets `general_preferences`.
- `coordination_context` is cross-profile: it is listed in every
  fixed-kind profile's Memories section, marked "Every profile", and every
  fixed-kind card build may read it. Availability and time zones matter to
  a work meeting as much as to daily life, and HCP treats this category as
  the one a person hands to any scheduling app. Moving such a memory to one
  profile narrows it to that profile. `location_context` stays with Daily
  tasks only: a work card should not surface where the person usually is.
  The Grounding Meet action does not read memories today; when it starts
  proposing times it reads `coordination_context` and nothing else.
- Group-scope memories never route to a profile: they describe the group
  and may be about other people. Profiles receive only memories the owner's
  agent saved about the owner (scopes `global`, `conversation`, `project`).
- The person can move a memory to any of their profiles, including a
  custom one, or to no profile. An explicit choice (`profile_id`) wins over
  the category's default.
- Custom profiles have no category of their own. Until per-card sources
  land (#1971), a custom card's rebuild keeps reading all of the owner's
  own memories through its lens, as today; fixed-kind cards read only the
  memories routed to them.
- The guard does not change in this slice. `health_context` memories pass
  the same keyword list as today, so fitness and wellbeing habits reach the
  Health profile and diagnosis-level text is still refused while the switch
  is on (#1977 open question 1 stays open and is not needed here).
- A group-scope save with category `health_context`, `location_context`,
  `purchase_history_preferences` or `values_and_ethics` is refused
  (`memory_category_not_shared`): those describe one person, not a group.
  This matches the existing rule that group memories always run the
  sensitive guard.

### Declaration type: what the person said versus what the agent inferred

- `user-declared`: the person typed the memory on a Memory page, edited it,
  or later confirmed it. Backfill: `source = 'manual'`.
- `model-inferred`: every agent save, with a `confidence` of `low`,
  `medium` or `high`. Backfill: every other source, confidence `medium`.
- An edit by the person turns a model-inferred memory into a user-declared
  one.
- Memory rows show it as today's source labels ("Added by you", "From a
  correction", …) plus a category chip. No new vocabulary in the UI.
- The HCP conflict rule (an inferred memory that contradicts a declared one
  in the same category is quarantined until the person reviews it) is
  step 5, optional in this slice.

### What the agent decides and what the server decides

| Decision | Who | How |
|---|---|---|
| Category and confidence | Agent | New required `category` and optional `confidence` tool parameters; the tool description and the `## Memories` section carry the table above in short form with one example per row |
| Scope | Agent, checked by the host | As today, with a sharper rule: group scope only for what the group shares and may all see; never one member's preference, health, daily life or anything said privately; conversation for the owner's own corrections in this chat; global only for "always" |
| Profile | Server | `profile_kind_for(category)` (`work`, `health`, `daily`, `all` for `coordination_context`, or none), overridden by an explicit `profile_id` the person set |
| Declaration | Server from the actor | Runner route: always `model-inferred`. Account route: `declaredBy: "agent"` from the Mac agent runtime, `"user"` (default) from the Memory pages |
| Group membership, scope ids, dedup, guard | Server | Unchanged |

### Data (migration 0147)

```sql
ALTER TABLE cloud_account_memories
    ADD COLUMN category TEXT NOT NULL DEFAULT 'general_preferences'
        CHECK (category IN ('general_preferences', 'goals_and_constraints',
            'health_context', 'education_learner_profile', 'work_context',
            'purchase_history_preferences', 'values_and_ethics',
            'location_context', 'coordination_context', 'hcp-custom:task_lessons')),
    ADD COLUMN declaration_type TEXT NOT NULL DEFAULT 'model-inferred'
        CHECK (declaration_type IN ('user-declared', 'model-inferred')),
    ADD COLUMN confidence TEXT NULL CHECK (confidence IN ('low', 'medium', 'high')),
    ADD COLUMN profile_id TEXT NULL
        REFERENCES cloud_common_ground_profiles(profile_id) ON DELETE SET NULL;

UPDATE cloud_account_memories SET declaration_type = 'user-declared' WHERE source = 'manual';
UPDATE cloud_account_memories SET confidence = 'medium' WHERE source <> 'manual';
UPDATE cloud_account_memories SET category = 'hcp-custom:task_lessons'
    WHERE source IN ('repeated_failure', 'outcome');

CREATE INDEX IF NOT EXISTS cloud_account_memories_owner_category_idx
    ON cloud_account_memories (owner_account_id, category) WHERE archived_at IS NULL;
```

No versions table, audit table, grants or status column in this slice;
those stay with the later #1977 PRs. The memory table is not part of the
`to_jsonb(cloud_accounts)` upgrade snapshots, so no after-query changes; an
upgrade test asserts the backfill.

### API

- `POST /v1/cloud/memory` and the runner save accept `category`,
  `confidence`, `declaredBy`. Unknown or missing category falls back to
  `general_preferences`, so old clients keep working.
- `PATCH /v1/cloud/memory/{id}` accepts `text`, `category`, `profileId`
  (`null` clears the explicit profile). A text edit by the person sets
  `declaration_type = 'user-declared'`.
- Every memory in responses gains `category`, `declarationType`,
  `confidence`, `profileId` (explicit or resolved from the category when the
  account has a profile of that kind) and `profileKind` (effective: `work`,
  `health`, `daily`, `all` or null).
- `GET /v1/cloud/common-ground/profiles/{id}/memories`: the owner's own
  active memories routed to that profile, newest first. For a fixed-kind
  profile this includes the cross-profile `coordination_context` memories
  that are not pinned elsewhere, each flagged `everyProfile: true`.
- The card view gains `memoriesSinceBuild`: routed memories updated after
  `built_at`.
- `memoryVersion` becomes 2 ("categories and profile routing"). The later
  #1977 search work takes 3.

### Prompt and tool wording (step 2)

The `reflection` tool keeps its name in this slice (the rename to
`memory_add` and friends stays in #1977 PR 2, so the TUI and cached prompts
are not disturbed twice). Its description and the `## Memories` section
gain, in compressed form:

> Pick the category that says what kind of information the memory is:
> work_context (projects, skills), education_learner_profile, health_context
> (exercise, sleep, diet habits), coordination_context (schedules,
> availability), location_context, purchase_history_preferences,
> general_preferences (how to answer), goals_and_constraints,
> values_and_ethics, or hcp-custom:task_lessons (how to do a task). Scope:
> group only for what the group shares and every member may see, never one
> person's preference, health or private remark; conversation for the
> owner's corrections in this chat; global only for "from now on" or
> "always". Memories about the person are filed to their Work, Health or
> Daily tasks profile by category.

The prompt keeps the disclosure rule, the duplicate check and the sensitive
rule. The Mac cache line format becomes
`- <timestamp> [<source>|<category>|<declaration>] <text>`; the parser
accepts the old two-field form.

## Steps

Each step is one PR, reviewed and merged before the next starts. Branches
come from fresh `origin/main` in their own worktree.

| Step | PR | Scope | Depends on | Verification |
|---|---|---|---|---|
| 0 | this doc | Commit this document next to `hcp-memory-plan.md`, fix the migration numbers there, comment on #1977 that this slice goes first | nothing | review |
| 1 | server schema and routes | Migration 0147, `memory_store/routing.rs` (category list, `profile_kind_for`, group-scope category check), save/update/list carry the new fields, runner save forces `model-inferred`, `memoryVersion` 2, audit detail gains category | nothing | `scripts/test-cloud-migrations.sh`, memory route tests, upgrade test for the backfill; old clients unaffected |
| 2 | agent tool and prompts | `reflection` gains `category` and `confidence`; description and `## Memories` routing rules on Mac and in cloud runs; Mac runtime and runner transport send the fields; cache line format and parser | 1 | Rust tests for the new rules and the parser; a Mac session and a cloud run each save a work, a health and a group memory with the right fields |
| 3 | server profile routing | Fixed-kind card builds read only routed memories plus cross-profile ones; group-scope memories never feed a card; `profiles/{id}/memories` route; `memoriesSinceBuild`; move via `PATCH` | 1 | Tests: a daily memory never reaches a work build (the #1971 bullet); a coordination memory reaches both the work and the health build until it is pinned; a group memory never reaches any build; move to a custom profile |
| 4 | Mac and iPhone | Loopback design preview first under `docs/design-previews/memory-routing/`; then: category chip on memory rows everywhere; account Memory tab filter by profile; Grounding card page gains a **Memories** section (routed list, Move to…, Remove) and "N new memories · Rebuild"; group info Memory section gets the chip only; flat settings style, sentence case, a title and at most one line | 1, 3 | Node and Swift unit tests; `tests/visual` pages; signed-in check on a loopback stack with a synthetic account |
| 5 (optional) | review and conflicts | Migration 0148 `status` (`active`, `conflicted`); an inferred memory in the same category and normalized dimension as a declared one is quarantined, hidden from agents and card builds, shown under "Needs your review" with Keep and Discard | 1, 4 | Route tests; UI tests |
| 6 | docs | `docs/memory.md` (categories, declaration, routing table), `docs/common-ground.md` (Memory source per profile), align `hcp-memory-plan.md`, deletion register note for `profile_id` | 1 to 5 | `pnpm check:english` |

End-to-end check after step 4, on a task-owned loopback stack with a
synthetic account and a disposable group: say "I run 5k every Tuesday" in a
private chat and find the memory on the Health profile; say "we decided to
ship on Friday" in the group and find it on the group info page for a second
member; say "from now on answer in British English" and find it under
Global; rebuild the Health card and see the topic cite the memory; rebuild
the Work card and confirm the running memory is absent.

## Open questions for the owner

1. The category-to-profile map above, in particular `goals_and_constraints`
   and `values_and_ethics` routed to no profile, and
   `education_learner_profile` routed to Work (alternatives: drop it from
   the agent's list, or route it to no profile). `coordination_context` as
   cross-profile was agreed on 2026-10-22.
2. Custom profiles keep reading all of the owner's own memories at rebuild
   until #1971 per-card sources (recommended), or read only memories moved
   to them.
3. Routed memories reach a card build without a confirmation step, as
   today (recommended, since the owner reviews the card before sharing it
   and step 5 adds review for conflicts only), or wait in "Needs your
   review" first.
4. Whether step 4 ships behind a preview flag first, as #1710 did.

## Not in this slice

Category-scoped grants and the access list, read audit, memory search and
the 20-entry bootstrap, the "Your context" page, export and the local MCP
server (all later #1977 PRs); renaming the `reflection` tool; per-card
sources and scenario templates (#1971); account profile fields (About,
Location, Time zone) suggested from memories; allowing diagnosis-level
health memories (#1977 open question 1).

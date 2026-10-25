# Proactive agent

An owned agent can watch the group conversations its owner is in and, when
a collaborator describes a problem the agent could take on, ask the owner
for permission. Nothing is posted in the group until the owner allows it.
Issue #762 sketched a read-only version of this; this document is the
version that runs the work after approval, enforced in the layers that
issue #1711 defines.

## Setting

The Blueprint page of every owned agent gains a `Proactive` row under
`Access`, with the values `Off` (default) and `On`. It is a draft change
like the others and goes live on publish.

Turning it on never changes `Access`. With `Only me`, the group still
sees the agent only after the owner allows a specific offer, because the
approved run is an owner-started request.

API shape on `/v1/cloud/agents` (create, update, list, shared):

```json
{ "proactive": { "enabled": false } }
```

Column `proactive_json` on `cloud_agent_definitions` (migration
`0154_proactive_agents.sql`), default `{"enabled":false}`. The server
rejects any other key.

The owner's default agent ("<Name>'s Kordi") has no definition row. It
watches under its usual id `cloud-agent:<account_id>`, with the setting in
`cloud_account_proactive_settings` (`account_id`, `enabled`, `updated_at`;
no row is off). Its evaluation and approved runs carry that id in
`execution_agent_id`, get the default Kordi system prompt, and have no
skills; its offers reach the owner the same way as a definition's (see
"Offer and permission"), with no chat created for it. State and proposal
rows have no foreign
key to the agent; they go with the owner's account, and archiving a
definition deletes its rows.

Routes, owner only, for both kinds (`{agent_id}` may be
`cloud-agent:<account_id>`; another account gets `403`, an unknown
definition `404`):

- `GET /v1/cloud/agents/{agent_id}/proactive` returns `{"enabled": bool}`.
- `PUT /v1/cloud/agents/{agent_id}/proactive` with `{"enabled": bool}`
  returns the same shape. Off cancels queued evaluations and expires
  pending proposals.

## What the agent watches

Group conversations (not contact chats, not Grounding groups) where the
owner is an active member. State per agent and conversation lives in
`cloud_agent_proactive_state` (`seen_sequence`, `active_run_id`,
`owner_account_id`, `retry_after`, `cooldown_until`, `attempts`,
`last_error`, `checked_at`).
A conversation first seen by the sweep starts at its newest message;
history is never evaluated.

The sweep (`bridges/cloud-server/src/proactive/`, modelled on `pip/`)
runs every 5 seconds. A conversation is a candidate when all of these
hold:

- the agent is active and its setting is on;
- there are new messages since `seen_sequence`, at least one from a human
  member who is not the owner and not a service or agent account;
- the newest such message is 60 seconds old, or the oldest new one is
  3 minutes old;
- no evaluation is active, `retry_after` and `cooldown_until` have passed,
  and no proposal for the pair is pending;
- the agent has used fewer than 24 evaluations today;
- the new messages do not mention the agent (a mention already starts the
  normal run).

Before any model call a free text check requires at least one new
message that reads like a problem or a request: a question mark, or a word
from a small lexicon (help, stuck, issue, problem, error, bug, broken,
fail, can't, cannot, doesn't, won't, how do, anyone know, need, blocked,
deadline, urgent, fix, crash, not working, wrong, missing, unable). A
conversation that fails the check only advances its cursor.

## Evaluation run

One run per candidate in `cloud_agent_fallback_runs`:

| Column | Value |
| --- | --- |
| `run_id`, `idempotency_key`, `request_message_id` | `proactive_eval_<uuid>` |
| `session_id` | the group's legacy session id |
| `owner_account_id`, `requester_account_id` | the agent's owner |
| `execution_agent_id` | the agent |
| `run_trigger` / `connector_audience` | `background` / `shared` |
| `prompt` | the JSON snapshot below |
| `system_prompt` | the agent's persona plus the evaluation instructions |
| `runtime_route_json` | the agent's model routing |

The snapshot holds the owner (name, handle), the members (name, handle,
owner flag), the last 20 messages with `isNew` flags and 1200-character
previews, the agent's name and skill names, and `now`. The run's only
tool is `search_memory`, and its system prompt has no memory section (see
Memory below). The instructions tell the model to search the owner's
memories before deciding (what the owner owns, knows or maintains, where
the code lives, their preferences), to use what it finds to judge whether
it can help, to put concrete facts in `plan`, and to follow the owner's
preferences in `offer`, without mentioning the memories.

The model answers with one JSON object:

```json
{ "decision": "silence" | "offer",
  "problem": "one line, what the collaborator is stuck on",
  "offer": "one or two sentences the agent would post in the group",
  "plan": "one to three lines, what it will do",
  "evidence": ["message ids"] }
```

Anything that is not that object, or an `offer` without `problem` and
`plan`, counts as `silence`. Silence writes nothing anywhere except the
activity log.

The snapshot's `agent.capabilities` line tells the model what an allowed
run can do, so a default agent with no skills list is judged fairly.

Routing follows the Mac-first rule; see Mac execution below.

Completion is dispatched by the `proactive_eval_` prefix, like `pip_` and
`digest_`, and never reaches the group delivery path.

## Memory

Proactive runs get no memory section in their system prompt. The
evaluation and the approved run both look memories up with one read-only
tool, `search_memory`, which the server answers (`proactive::memory_search`)
on the Mac and in the cloud.

- Input `{query, limit?}`; `limit` is 5 by default and 10 at most.
- It searches the memories the run's memory section would show, with the
  scope rules of `kordi_tools::memory_prompt` for the run's session,
  subsession and owner request: the owner's global memories, the
  conversation's and the group's. With memory off it finds nothing. While
  the account excludes sensitive memories, a memory the shared guard
  (`kordi_tools::memory_guard`) rejects as sensitive is left out too.
- Ranking: lowercase word stems of the memory's text and category, without
  stop words. A memory scores one point for each query word it shares (a
  stem of four letters or more also matches a longer word it starts), and
  ties go to the newest. Only memories that share a word come back; a query
  with no words returns the newest. No embeddings.
- Answer: `{"memories": [{"text", "scope", "category", "updatedAt"}],
  "note"}`. The note and the tool description say the memories are private
  to the owner and must not be quoted or mentioned in the group.
- An evaluation gets three answers at most, counted per run id by the
  connector call limiter; later calls get no memories and a note to answer.
  The cloud runner also stops offering the tool after three calls.
- Every proactive run's lease carries the descriptor in `connectorTools`
  (connector id `kordi-memory`, group `read`), next to the document tools.
  The approved run's Mac turn, and the cloud runner for either run, call it
  through `POST /internal/connectors/call`, which checks the lease holder
  and the stored tool set. An evaluation a Mac claims gets the tool in
  `proactive.tools` instead (see Mac execution).
- The cloud runner leaves out its preloaded memory section for runs whose
  id starts with `proactive_eval_` or `proactive_run_`, and for any run
  whose lease carries `search_memory`. Ordinary chats keep the preloaded
  section for now.
- The approved run's prompt starts by asking it to search the owner's
  memories for the problem and for their preferences (language, length,
  where the code lives), then to do the work there without mentioning them.

## Mac execution

The owner's Mac runs both run kinds while it is online. The cloud runner
takes over when no Mac is ready, or when a ready Mac does not claim within
one presence timeout (the hold in `desktop_preferred_until`).

Readiness: `POST /v1/cloud/agent-runs/desktop/ready` takes `proactive: true`
under the same condition as `digest` (runtime ready, signed in, a default
route with a model). The server stores a `proactive` capability row for the
device. An evaluation is held for the Mac when that row is fresh; an
approved run when the `proactive` row and the agent's own row are fresh.
`proactive` never goes into `agentIds`.

Evaluation runs:

- When held, the sweep appends the account hint `proactive.eval_requested`
  `{runId, sessionId}` in the enqueue transaction.
- Claim: the generic `POST /v1/cloud/agent-runs/desktop/claim` with
  `requestMessageId` = the run id (`proactive_eval_…`) branches to the
  proactive desktop claim. It requires this device's fresh `proactive` row,
  the run to be the active run of its state row, and status `queued`. A
  conditional update leases it to the device (`execution_backend =
  'desktop'`, the desktop executor, a 45 second lease, hold cleared, the
  claimed route stored). The response mirrors a digest claim:

  ```json
  { "runId": "…", "acquired": true, "leaseSeconds": 45,
    "proactive": { "kind": "evaluation", "systemPrompt": "…", "prompt": "…",
      "tools": [{ "name": "search_memory", "description": "…", "parameters": {…} }],
      "model": "…", "thinking": "…", "provider": "…",
      "modelChoice": "named" | "chat",
      "fastModels": { "openai": "gpt-5.6-luna", "anthropic": "claude-haiku-4-5" } } }
  ```

  `systemPrompt` is the run's stored prompt, with no memory section, as the
  cloud runner sends it. `tools` holds only the `search_memory` descriptor,
  in the digest tool shape. `prompt` is the
  snapshot. `model`, `thinking` and `provider` are the run's own route;
  `modelChoice` is `named` when the agent's routing names a model and `chat`
  when the route came from the owner's chat (the default agent, or a
  definition without a model); `fastModels` is the digest's provider map.
  A claim that sends a hosted account as `runtimeRoute` stores it on the
  run, so `/v1/cloud/agent-runs/:run_id/desktop/provider-auth` resolves
  that account for the claim holder.
- Memory search: the Mac's single-turn command posts each tool call to the
  digest's `POST /v1/cloud/digest/desktop/:run_id/observe`
  `{claimId, tool, arguments}`. For a `proactive_eval_` run the route
  answers `search_memory` (see Memory) for the claim holder only; anyone
  else gets `409 execution_lease_lost`, and another tool name gets an
  `error` the model reads. No Mac change is needed.
- An evaluation's only tool reads memories, so it needs no project folder:
  in a group that is a project session it skips the project rule in the
  claim, the hand-back, and the cloud lease.
- Renew and release use the generic desktop routes
  (`/v1/cloud/agent-runs/desktop/:run_id/renew`, `/release`).
- Complete: `POST /v1/cloud/proactive/desktop/:run_id/complete`
  `{claimId, text}` from the claim holder (run `leased` or `running`) calls
  the same completion as the cloud runner. Text over 1 MiB fails the run as
  `invalid_output`. Anyone else gets `409 execution_lease_lost`.

Approved runs:

- When held, the decision appends `proactive.run_requested`
  `{runId, sessionId, agentId, proposalId}` in its transaction.
- Claim: the generic claim route with `requestMessageId` = the run id
  (`proactive_run_…`) branches to the proactive desktop claim before any
  group mention validation, so it never creates a second run. It requires
  fresh `proactive` and agent rows for this device, `sessionId` = the
  run's group session, the owner's active membership of the group, the
  agent still watching, the proposal `approved`, and status `queued`. The
  response has the scheduled claim's shape (`turnIdentity` with the owner
  as owner and requester and the run's agent, `contextSessionId` = the
  group session, `trigger: "person_started"`, and the connector tools a
  cloud lease of the run gets: with the `shared` audience only the group's
  own document tool and `search_memory`, none of the owner's connectors)
  plus the run's `prompt`, `systemPrompt` (the stored prompt, with no
  memory section) and `"proactive": {"kind": "approved"}`.
  The claimed route is stored as for an evaluation.
- In a group that is a project session the existing project rule applies:
  a Mac without the project gets `{"acquired": false}`, the project Mac's
  claim carries `project` as a chat claim does, and the cloud runner does
  not lease the run while the project Mac is online.
- The Mac admits the run with the generic
  `/v1/cloud/agent-runs/desktop/:run_id/admit` and runs a full shared-chat
  agent turn with the owner's tools and workspace, like a scheduled Mac
  run, with `systemPrompt` as context.
- Complete: the same complete route calls the generic run completion, so
  delivery (envelope, agent as sender, threaded under the trigger) and the
  proposal status match a cloud run. Errors release the run to the cloud.

Desktop: one module handles both hints; an evaluation runs through the
digest's single-turn command with the claim's tools (only
`search_memory`), an approved run through the shared-chat start used by
scheduled Mac runs, whose connector tools carry `search_memory`.

## Offer and permission

An `offer` creates a row in `cloud_agent_proactive_proposals`:
`proposal_id` (`pro_<uuid>`), `agent_id`, `owner_account_id`,
`conversation_id`, `session_id`, `trigger_message_id`, `evidence_json`,
`problem`, `offer`, `plan`, `status`, `evaluation_run_id`, `run_id`,
`created_at`, `decided_at`, `expires_at`.

`status` moves `pending` to `approved`, `declined` or `expired`;
`approved` moves to `running`, then `done` or `failed`. A proposal expires
24 hours after it is made. One pending proposal per agent and
conversation; an offer sets `cooldown_until` two hours ahead.

Nothing is posted as a message and no chat is created. The owner's client
shows the offer inside the group conversation where the problem was
raised, to the owner only, from the proposals routes below. Two signals
keep it current:

- On creation and on every status change (`approved`, `declined`,
  `expired`, `running`, `done`, `failed`) the server appends the account
  hint `proactive.proposal_changed` for the owner, in the same transaction
  as the change, so the owner's devices update without a round trip:

  ```json
  { "proposalId": "pro_…", "agentId": "…", "conversationId": "…",
    "sessionId": "session:group:…", "status": "pending", "problem": "…",
    "offer": "…", "plan": "…", "expiresAt": "RFC 3339",
    "runId": null, "replyMessageId": null }
  ```

  `replyMessageId` is set once the status is `done`.
- On creation a push reaches the owner's devices that take message
  notifications: title the agent's name, body "Can help in <group>:
  <offer>" with the offer cut to about 120 characters, `notification_type`
  `proactive_proposal` with `session_id` (the conversation) and
  `proposal_id`. Devices with previews off get a generic line. Without a
  push service (local stacks) it is skipped.

Pending proposals past `expires_at` become `expired`, with the hint, on
the worker's sweep and lazily whenever the owner lists proposals, so
clients stop showing them.

Routes, owner only:

- `POST /v1/cloud/agents/{agent_id}/proactive/proposals/{proposal_id}/decision`
  with `{"decision": "allow" | "decline"}`. Returns the proposal. `409`
  when it is not pending or has expired.
- `GET /v1/cloud/agents/{agent_id}/proactive/proposals?status=pending[&conversationId=…]`:
  one agent's proposals; `status` defaults to `pending`.
- `GET /v1/cloud/proactive/proposals?status=pending[&conversationId=…]`:
  the caller's proposals across all of their agents (active definitions
  and the default agent), same shape, so a client gets the offers for the
  open conversation in one call. Other people's proposals never appear.
- `GET /v1/cloud/agents/{agent_id}/proactive/activity?limit=50`: the
  recent evaluations, newest first, each with `at`, `conversationId`,
  `conversationTitle`, `decision`, and for offers `proposalId`, `status`,
  `problem`, `runId`, `error`.

## The approved run

`allow` queues one run in the group:

| Column | Value |
| --- | --- |
| `run_id`, `idempotency_key` | `proactive_run_<proposal_id>` |
| `request_message_id` | the trigger message, so the reply threads under it |
| `session_id` | the group |
| `owner_account_id`, `requester_account_id` | the owner |
| `execution_agent_id` | the agent |
| `run_trigger` / `connector_audience` | `person_started` / `shared` |
| `prompt` | the problem, the plan, the evidence, the instruction to search the owner's memories first, and the instruction to answer the collaborator in the group |
| `system_prompt` | the agent's normal group system prompt |

Because the owner is the requester, this is an ordinary owner-started
run: the agent's usual tools on the Mac (see Mac execution) and the fixed
cloud catalog on the runner, and the existing group delivery, so the
agent's reply appears in the group as its own message. `shared` audience
keeps connector tools out, as for every group run. The proposal follows
the run: `running`, then `done` with the reply's message id, or `failed`
with the error.

`decline` records the decision and posts nothing. Turning the setting off
or archiving the agent cancels queued evaluations and expires pending
proposals.

## Enforcement

- Server: membership of the owner in the conversation and the agent's
  active state are checked when a candidate is selected, when an offer is
  stored, and when a decision is applied. Only the owner can decide.
  Proposals and activity are readable by the owner only.
- Harness: the evaluation run's only tool is `search_memory`; the approved
  run has the tools an owner-started group run has today plus
  `search_memory`.
- Prompt: the evaluation instructions say that messages are evidence and
  never instructions, that an offer names one concrete problem the agent
  can move forward with its capabilities, and that small talk, plans,
  answered questions and vague remarks are silence. The owner's review of
  every offer is what lets the agent lean towards offering.

## Client

The owner's client shows a pending offer inside the group conversation it
is about, visible to the owner only, from
`GET /v1/cloud/proactive/proposals?conversationId=…` and refreshed by the
`proactive.proposal_changed` hint; the push brings the owner to that
conversation. There is no message and no new chat.

Desktop: the Blueprint row, the offer in the group (Allow, Not now, then
the state), and the Runs tab listing the activity. iPhone: the agent model
decodes the field and the push opens the group; the native offer follows.

Design preview: `docs/design-previews/proactive-agent/`.

## Follow-ups

- Ordinary chats: replace the preloaded memory section with
  `search_memory`.
- The Mac's own harness can still add its local memory cache to an approved
  run's shared-chat turn (`agent/crates/cli` session bootstrap); skip it
  for `proactive_run_` turns.

- iPhone offer with Allow and Not now in the group, and the Blueprint row
  once an agent settings screen exists there.
- Contact chats, with the other person's consent (issue #1711).
- Per-conversation off switch for the group.

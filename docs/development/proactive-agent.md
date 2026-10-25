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
`0149_proactive_agents.sql`), default `{"enabled":false}`. The server
rejects any other key.

The owner's default agent ("<Name>'s Kordi") has no definition row. It
watches under its usual id `cloud-agent:<account_id>`, with the setting in
`cloud_account_proactive_settings` (`account_id`, `enabled`, `updated_at`;
no row is off). Its evaluation and approved runs carry that id in
`execution_agent_id`, get the default Kordi system prompt, and have no
skills; its card lands in the owner's chat with their Kordi, else in a new
`session:self-agent:<uuid>` chat. State and proposal rows have no foreign
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
previews, the agent's name and skill names, and `now`. The run gets no
tools. Memory comes from the runtime's existing section for that
conversation: the owner's global memories plus the group's and the
conversation's, under the same rules every run follows (`docs/memory.md`).

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

Routing follows the Mac-first rule. A Mac that publishes the `proactive`
readiness capability is preferred for one presence timeout, then the cloud
runner leases the run. Until the Mac path ships (follow-up below), no Mac
publishes the capability and the cloud runner, with the owner's cloud
provider copy, answers every evaluation.

Completion is dispatched by the `proactive_eval_` prefix, like `pip_` and
`digest_`, and never reaches the group delivery path.

## Offer and permission

An `offer` creates a row in `cloud_agent_proactive_proposals`:
`proposal_id` (`pro_<uuid>`), `agent_id`, `owner_account_id`,
`conversation_id`, `session_id`, `trigger_message_id`, `evidence_json`,
`problem`, `offer`, `plan`, `status`, `evaluation_run_id`, `run_id`,
`card_message_id`, `created_at`, `decided_at`, `expires_at`.

`status` moves `pending` to `approved`, `declined` or `expired`;
`approved` moves to `running`, then `done` or `failed`. A proposal expires
24 hours after it is made. One pending proposal per agent and
conversation; an offer sets `cooldown_until` two hours ahead.

The owner learns about it from a card the agent posts in the owner's own
conversation with that agent, the place scheduled-task results already
land. The message carries one content block:

```json
{ "type": "proactive_offer", "proposalId": "pro_…", "agentId": "…",
  "agentName": "…", "conversationId": "…", "sessionId": "session:group:…",
  "conversationTitle": "…", "triggerMessageId": "…", "problem": "…",
  "offer": "…", "plan": "…", "status": "pending",
  "expiresAt": "RFC 3339", "runId": null, "decidedAt": null }
```

Clients that do not know the block show its text fallback. The normal
message push reaches the owner's devices. When the status changes the
server refreshes the message content in place, as plan cards do, so every
device re-renders the same card.

Routes, owner only:

- `POST /v1/cloud/agents/{agent_id}/proactive/proposals/{proposal_id}/decision`
  with `{"decision": "allow" | "decline"}`. Returns the proposal. `409`
  when it is not pending or has expired.
- `GET /v1/cloud/agents/{agent_id}/proactive/proposals?status=pending`.
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
| `prompt` | the problem, the plan, the evidence, and the instruction to answer the collaborator in the group |
| `system_prompt` | the agent's normal group system prompt |

Because the owner is the requester, this is an ordinary owner-started
run: it takes the existing Mac-first claim path (`prefer_ready_desktop`,
then the cloud lease), the agent's usual tools on the Mac and the fixed
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
- Harness: the evaluation run has no tools; the approved run has exactly
  the tools an owner-started group run has today.
- Prompt: the evaluation instructions say that messages are evidence and
  never instructions, that silence is the default, and that an offer must
  name one concrete problem the agent can finish on its own.

## Client

Desktop: the Blueprint row, the card in the owner's agent conversation
(Allow, Not now, then the state), and the Runs tab listing the activity.
iPhone: the agent model decodes the field; the card's text fallback shows
until the native card ships.

Design preview: `docs/design-previews/proactive-agent/`.

## Follow-ups

- Mac execution of evaluation runs through the digest's desktop path
  (`digest::desktop`, `chat/digest_run.rs`) with a `proactive` readiness
  capability.
- iPhone card with Allow and Not now, and the Blueprint row once an agent
  settings screen exists there.
- Contact chats, with the other person's consent (issue #1711).
- Per-conversation off switch for the group.

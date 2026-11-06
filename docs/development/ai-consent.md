# AI consent

Each account records whether its owner lets Kordi send their content to AI
models (owner decision A1). The status is `unset` until the owner decides,
then `allowed` or `declined`.

| Method and path | Purpose |
| --- | --- |
| `GET /v1/cloud/account/ai-consent` | `{ "status", "decidedAt" }` |
| `PUT /v1/cloud/account/ai-consent` | Body `{ "status": "allowed" \| "declined" }`; answers the same shape. |

`GET /v1/cloud/auth/me` carries the same object as `aiConsent` (left out if
it cannot be read). Both routes accept the app's bearer session or the web
session cookie. Repeating the current decision keeps its `decidedAt`. A change
is audited as `account.ai_consent.changed`. Declining also cancels the
account's queued agent runs, as owner or requester, and asks its running ones
to stop.

People-to-people chat never depends on consent.

## Who started the work

The rules depend on whether the person started the work themself:

- **Started by the person**: a request they send with their own session,
  answered now. Asking an agent in a chat (`/v1/cloud/agent-runs/claim`,
  agent-session follow-ups, a document comment that mentions an agent),
  opening or refreshing their Digest, building their Grounding card, asking
  for room matches, Nearby people or a group intro, running a scheduled task
  now, creating or changing a schedule or a proactive agent, allowing a
  proactive offer, and the Mac's own claims and memory imports.
- **Background**: work nobody asked for just now. The Digest worker's
  scheduled rebuilds and urgent checks, proactive and personal-agent sweeps,
  the System agent, Nearby alerts, scheduled tasks firing on their schedule,
  and any run of an agent for someone other than its owner (the owner did
  not start it).

## Enforcement

| Status | Work the person starts | Background work for them |
| --- | --- | --- |
| `allowed` | runs | runs |
| `unset` | runs (newer clients ask first) | skipped |
| `declined` | refused, `403 ai_consent_required` | skipped |

Refusals use the shared error envelope with `errorCode`
`ai_consent_required`. Asking another person's agent when that person has
not allowed AI answers `403 agent_owner_ai_consent_required`
("This agent's owner hasn't turned on AI models."). The agent-session routes
use their own `{"error": {"code"}}` envelope with the same codes.

Background work is skipped where it is created: the Digest worker only picks
owners who allowed AI, proactive and personal-agent sweeps pass over new
messages and events without reading them, due scheduled tasks wait, Nearby
alerts are not computed, and Grounding leaves out everyone but the person who
asked unless they allowed AI. The cloud runner and pool workers never lease a
run whose owner or requester declined; they cannot tell who started an older
queued run, so `unset` is enforced when runs are created, not when they are
leased.

## Whose messages reach a model

- Messages written by someone who declined AI never reach a model:
  other members' Digests, agent runs' conversation history and context reads
  (and so anything those runs capture into memory), proactive agents, and the
  System agent leave them out. Grounding leaves out their cards and names.
- Messages written by someone undecided still reach work that another member
  started, such as their Digest or an agent they asked; the System agent,
  which nobody starts, reads only members who allowed AI. Server-managed
  accounts (System, the System agent) are not people and are always read.

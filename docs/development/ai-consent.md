# AI consent

Each account records whether its owner lets Kordi send their content to AI
models (owner decision A1). The status is `unset` until the owner decides,
then `allowed` or `declined`.

| Method and path | Purpose |
| --- | --- |
| `GET /v1/cloud/account/ai-consent` | `{ "status", "decidedAt" }` |
| `PUT /v1/cloud/account/ai-consent` | Body `{ "status": "allowed" \| "declined" }`; answers the same shape. |

`GET /v1/cloud/auth/me` carries the same object as `aiConsent`. Both routes
accept the app's bearer session or the web session cookie. Repeating the
current decision keeps its `decidedAt`. A change is audited as
`account.ai_consent.changed`.

## Enforcement

Only `declined` is enforced; `unset` behaves as before so older clients keep
working, and newer clients ask before the first AI action. People-to-people
chat never depends on it.

AI routes refuse a declined account with `403` and
`{"errorCode": "ai_consent_required"}`:

- agent run claims (`/v1/cloud/agent-runs/claim`, and the Mac's
  `/v1/cloud/agent-runs/desktop/claim` and `/desktop/tasks`, which start memory
  imports), refused when the requester or the agent's owner declined;
- scheduled tasks: creating one and running one now;
- `POST /v1/cloud/digest/refresh`;
- `POST /v1/cloud/common-ground/card/build`;
- turning a proactive agent on and allowing a proactive offer.

Background work skips declined accounts instead: the cloud runner and pool
workers never lease a run whose owner or requester declined, due scheduled
tasks wait, digest refreshes and urgent checks do nothing, Grounding runs are
not queued, and proactive and personal agents pass over new messages without
reading them. Memory capture happens only inside agent runs, so it stops with
them.

The System agent leaves out every message from a member who declined: those
messages are never read, quoted or summarized. Proactive agents of other
members leave them out the same way.

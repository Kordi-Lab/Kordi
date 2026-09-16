# Pip, the built-in plan agent

Stage 1 of the proactive plan-card work for #1546. Pip is a system-managed
Cloud agent that lives in every group conversation, notices when a concrete
plan is forming, and keeps one shared plan card per conversation honest. It
runs on a Kordi-operated provider credential, never on a member's key, and it
never reads or writes anyone's personal calendar.

## Identity

Pip mirrors the Kordi Support agent's plumbing: a system account
(`acct_kordi_pip` by default), a locked agent definition
(`cloud_agent_kordi_pip`), a default agent profile so member listings render
it, and a `ServiceProviderAuth` credential resolved at run time from server
configuration. It is bootstrapped at server start and joins every existing
group conversation; new groups get Pip at creation. Direct and AI sessions are
excluded until both clients render a third member there.

## Configuration

| Variable | Meaning |
| --- | --- |
| `KORDI_PIP_ENABLED` | `true` to provision Pip and start its sweep |
| `KORDI_PIP_OPENAI_API_KEY` | Kordi-operated OpenAI key, required when enabled |
| `KORDI_PIP_OPENAI_MODEL` | Model name; defaults to the support agent's default |
| `KORDI_PIP_ACCOUNT_ID`, `KORDI_PIP_AGENT_ID`, `KORDI_PIP_AGENT_NAME`, `KORDI_PIP_OWNER_EMAIL` | Identity overrides; defaults are fine for every environment |

The isolated development stack passes these through `deploy/dev/compose.yaml`
from the ignored `deploy/dev/.env` file.

## How a run happens

1. A five-second sweep (`bridges/cloud-server/src/pip/worker.rs`) selects
   conversations whose latest message sequence moved past Pip's cursor, or
   whose open card starts within 24 hours or 2 hours and has not yet received
   that reminder. Selection is an atomic per-row reservation, bounded to ten
   conversations per pass.
2. The sweep queues one cloud run (`pip_` prefix) whose prompt is a bounded
   JSON snapshot: members, the last 40 text messages with envelopes decoded,
   the open card with per-participant RSVPs, and the hooks that woke Pip.
3. The cloud runner (`bridges/cloud-agent-runner/src/pip.rs`) runs the model
   with exactly one tool, `plan_card`. Every tool call is forwarded to
   `POST /v1/cloud/agent-runs/:run_id/plan-card`, authenticated with the
   runner token and bound to the run's own conversation.
4. The server records the action as Pip (`bridges/cloud-server/src/plan_cards/runner.rs`).
   Pip may record another active member's RSVP, confirmation, or
   cancellation from what that member said; a signed-in member still acts only
   for themselves.
5. The run's final JSON `{"message": ..., "hooksHandled": [...]}` is posted as a
   normal message from Pip when `message` is non-empty, and the handled hooks
   are stored so a reminder never fires twice for the same card.

Failures back off at 1 minute, 5 minutes, 30 minutes, 2 hours, then 12 hours
between attempts. Progress is never reset on failure, so a persistently failing
provider costs a handful of calls per day, not thousands.

## What this stage does not include

- Card rendering on macOS and iOS. Cards exist as rows; Pip's replies are
  plain messages.
- Pip in direct and AI sessions.
- `reach_out` questions to a single person and calendar writes on confirm.
- Decision and route cards.

## Validation

Unit coverage: `cargo test -p kordi-cloud-server --lib pip::` and
`cargo test -p kordi-cloud-agent-runner --lib pip::`. Manual validation uses
the isolated development backend with synthetic accounts and a fresh group;
record the sweep, the card rows, and Pip's posted messages for the proposal,
partial decline, organizer cancellation, ambiguity, and reminder cases.

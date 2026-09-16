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

## How the card reaches the clients

Pip's message carries a `plan_card` block next to its text: the card's
identity, state, title, time, place, unresolved fields, and every
participant's RSVP. macOS (`app/desktop/src/kordi-app/components/planCard.tsx`)
and iOS (`app/ios/Kordi/Features/Conversation/PlanCardView.swift`) render the
block as a card with "I'm in", "Can't make it", and, for the organizer, a
confirm button. Card instants are always RFC 3339 with an offset, whether
they arrive in a block or as the reply to an action.

A member's button press goes to `POST /v1/cloud/plan_cards` as that member.
After a successful change the route refreshes the card inside Pip's newest
message that carries it, in place and without an edit marker, so every
device shows the response on the card itself. No chat line and no model run
is spent on a vote; Pip's own messages stay reserved for guiding the group.

A transcript shows one card per plan. Only the newest message carrying a
card renders it, at the newest snapshot known for that plan; every earlier
copy keeps just its text. The card therefore sits next to the latest
activity and its buttons always act at the current revision.

Both clients recognise Pip by its account id: it gets its own chick mark
instead of a generated face, and a "Built-in agent" tag next to its name.

## What this stage does not include

- Pip in direct and AI sessions.
- `reach_out` questions to a single person and calendar writes on confirm.
- Decision and route cards.

## Validation

Unit coverage: `cargo test -p kordi-cloud-server --lib pip::`,
`cargo test -p kordi-cloud-server --lib plan_cards::` and
`cargo test -p kordi-cloud-agent-runner --lib pip::`.

Validated on the isolated development backend (2026-09-16) with two synthetic
accounts in a fresh group, a Kordi-operated key, and no @-mention anywhere:

| Step | Messages | Pip's action | Card |
| --- | --- | --- | --- |
| Proposal | organizer proposes two options, peer picks one, organizer locks it | propose, then confirm; posts one message | revision 3, `confirmed`, organizer yes, peer pending |
| Partial decline | peer: "I can't make it on Saturday anymore" | rsvp no on the peer's behalf; posts one message | revision 4, still `confirmed`, peer no |
| Organizer cancels | organizer: "cancel lunch for everyone" | cancel; posts one message | revision 5, `canceled` |

Every step produced exactly one cloud run, about 20 seconds after the last
message; no run failed and Pip's own messages did not queue a further run.
Manual runner calls also confirmed that a member's own call may not act for
another member while Pip's run may, inside its own conversation only.

Two failure modes found and fixed during validation: the model sends optional
strings as `""` (an empty `existingEventId` is now a new card, not a missing
one), and it may send ambiguous times (`startAt`/`endAt` now require an RFC
3339 offset and return a 400 that explains the format).

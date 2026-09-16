# PiP, the built-in plan agent

Stage 1 of the proactive plan-card work for #1546. PiP is a system-managed
Cloud agent that lives in every group conversation, notices when a concrete
plan is forming, and keeps one shared plan card per conversation honest. It
runs on a Kordi-operated provider credential, never on a member's key, and it
never reads or writes anyone's personal calendar.

## Identity

PiP mirrors the Kordi Support agent's plumbing: a system account
(`acct_kordi_pip` by default), a locked agent definition
(`cloud_agent_kordi_pip`), a default agent profile so member listings render
it, and a `ServiceProviderAuth` credential resolved at run time from server
configuration. It is bootstrapped at server start and joins every existing
group conversation; new groups get PiP at creation. Direct and AI sessions are
excluded until both clients render a third member there.

## Configuration

| Variable | Meaning |
| --- | --- |
| `KORDI_PIP_ENABLED` | `true` to provision PiP and start its sweep |
| `KORDI_PIP_OPENAI_API_KEY` | Kordi-operated OpenAI key, required when enabled |
| `KORDI_PIP_OPENAI_MODEL` | Model name; defaults to the support agent's default |
| `KORDI_PIP_ACCOUNT_ID`, `KORDI_PIP_AGENT_ID`, `KORDI_PIP_AGENT_NAME`, `KORDI_PIP_OWNER_EMAIL` | Identity overrides; defaults are fine for every environment |

The isolated development stack passes these through `deploy/dev/compose.yaml`
from the ignored `deploy/dev/.env` file.

## Persona and playbook

PiP is warm, brief, and practical. It speaks only when a hook gives it a
reason and never repeats a nudge. Its messages exist to move the group: open
a vote, ask the one person whose answer is missing (by `@handle`), confirm a
deal, or remind people shortly before the event. Member responses live on
the card, never in PiP's chat lines.

| Situation | What PiP does |
| --- | --- |
| The chat names competing days, times, or places | opens a vote on its own (`propose` a polling card with 2 to 4 options), without anyone asking |
| Votes or answers missing for a while | asks the missing people by name, once per card |
| The group settles, or the vote has a clear winner and the organizer agrees | `confirm` (with `optionId` when the poll decides it); one message saying what is fixed |
| A member cannot make it | `rsvp` no for that member only; the plan stands |
| The organizer cancels, or the group calls it off | `cancel` |
| Genuinely unclear whether a confirmed plan stands | asks one question and `reopen`s the card |
| 24 hours and 2 hours before start | one reminder each, while the card is open |

Confirming with an option marks everyone who voted for it as attending.
Confirming adds the plan to every attending member's Kordi calendar
(`bridges/cloud-server/src/plan_cards/calendar.rs`), keyed by the card so
later changes update the same entry; a decline or a cancellation removes it.

## When PiP spends a model call

PiP is always on in every group once `KORDI_PIP_OPENAI_API_KEY` is set;
`KORDI_PIP_ENABLED=false` switches it off. There are no per-group caps. A
five-second sweep considers a group only when one of these holds:

| Trigger | Condition |
| --- | --- |
| New messages | The chat has been quiet for 30 seconds, or 2 minutes have passed since the first unseen message |
| Card changed | Votes or answers changed the card and it has been quiet for 45 seconds |
| Reminder | An open plan starts within 24 hours or 2 hours and that reminder has not gone out |

New messages alone then pass a free text check
(`bridges/cloud-server/src/pip/context.rs`) before any run is queued: a clock
time or date written with digits, a day or plan word in English, Chinese, or
Arabic, or, while a card is open, a short answer such as "yes" or "can't".
Small talk without any of these moves PiP's cursor forward and costs nothing.
Recording votes and answers, refreshing cards, posting the calendar card on
confirm, and writing calendars never use the model.

### What a run sees

| Part | Limit |
| --- | --- |
| Messages | The newest 30, each cut to 400 characters, 6,000 characters in total; card-only messages are left out; `isNew` marks unseen ones |
| Members | Everyone up to 40; in a larger group the people speaking and on the card first, plus `memberCount` |
| Open card | Counts for going, declined, pending, and voted; each option's `voteCount`; above 30 participants only the organizer and people who have not answered are named |
| Tool results | The same compact card, never the full voter list |

## How PiP and the digest stay out of each other's way

- The digest does not read PiP's messages. They are coordination, not anyone's
  commitments, and reading them would rerun every member's digest each time a
  vote refreshes a card.
- Confirmed plans reach the digest as calendar events whose id starts with
  `plan:`. The digest treats them as confirmed context and never proposes
  updating or deleting them (`bridges/cloud-server/src/digest/pip_guard.rs`
  drops any such suggestion).
- The digest does not suggest a new event for an arrangement PiP is already
  tracking: a create suggestion whose sources all come from a chat where PiP
  holds a live plan is dropped.

## How a run happens

1. A five-second sweep (`bridges/cloud-server/src/pip/worker.rs`) selects
   conversations whose latest message sequence moved past PiP's cursor, whose
   card changed since PiP last looked (votes and answers, debounced by 45
   seconds), or whose open card starts within 24 hours or 2 hours and has
   not yet received that reminder. Selection is an atomic per-row
   reservation, bounded to ten conversations per pass.
2. The sweep queues one cloud run (`pip_` prefix) whose prompt is a bounded
   JSON snapshot: members with their `@handle`, the last 40 text messages
   with envelopes decoded, the open card with options, votes, and
   per-participant RSVPs, and the hooks that woke PiP.
3. The cloud runner (`bridges/cloud-agent-runner/src/pip.rs`) runs the model
   with exactly one tool, `plan_card` (propose with options, rsvp, vote,
   confirm with an option, reopen, cancel). Every call is forwarded to
   `POST /v1/cloud/agent-runs/:run_id/plan-card`, authenticated with the
   runner token and bound to the run's own conversation.
4. The server records the action as PiP (`bridges/cloud-server/src/plan_cards/runner.rs`).
   PiP may record another active member's RSVP, vote, confirmation, or
   cancellation from what that member said; a signed-in member still acts only
   for themselves.
5. When the run changed the card, PiP posts the card as its own message; the
   run's final JSON `{"message": ..., "hooksHandled": [...]}` is then posted as
   a separate text message from PiP when `message` is non-empty. `@Handle` tokens that
   match one member become real mentions. The handled hooks are stored so a
   reminder never fires twice, and the card revision PiP has seen is
   recorded so its own tool calls never wake the next sweep.

Failures back off at 1 minute, 5 minutes, 30 minutes, 2 hours, then 12 hours
between attempts. Progress is never reset on failure, so a persistently failing
provider costs a handful of calls per day, not thousands.

## How the card reaches the clients

A plan shows as two separate cards, each its own card-only message apart from PiP's text: a vote card while the group chooses between options, and a calendar card for the plan itself, posted when a single option is proposed or a vote is confirmed. Both refresh in place as the plan changes. Each card message carries a single `plan_card` block with a `view` of `vote` or `event`: the card's
identity, state, title, time, place, options with votes, unresolved fields,
and every participant's RSVP. macOS
(`app/desktop/src/kordi-app/components/planCard.tsx`) and iOS
(`app/ios/Kordi/Features/Conversation/PlanCardView.swift`) render the block as
a compact card in the style of the Kordi Support permission card: while the
card polls, the options are the buttons; otherwise "I'm in" and "Can't make
it", plus a confirm button for the organizer. Card instants are always RFC
3339 with an offset.

A member's button press goes to `POST /v1/cloud/plan_cards` as that member.
Votes and answers apply at any revision, so a member is never told to refresh
first. After a successful change the route refreshes the card inside PiP's
newest message that carries it, in place and without an edit marker, so
every device shows the response on the card itself. No chat line and no
model run is spent on a vote; PiP's own messages stay reserved for guiding
the group, and a later sweep lets PiP react when the votes change what
happens next.

A transcript shows one card per plan. Only the newest message carrying a
card renders it, at the newest snapshot known for that plan; every earlier
copy keeps just its text.

Both clients recognise PiP by its account id: it gets its own chick mark
instead of a generated face, and a "Built-in agent" tag next to its name.

## What this stage does not include

- PiP in direct and AI sessions.
- Handing a question to a member's own agent (for example to check that
  member's calendar). PiP mentions people; mentioning an agent does not yet
  start that agent's run.
- Decision and route cards.

## Validation

Unit coverage: `cargo test -p kordi-cloud-server --lib pip::`,
`cargo test -p kordi-cloud-server --lib plan_cards::` and
`cargo test -p kordi-cloud-agent-runner --lib pip::`.

Validated on the isolated development backend (2026-09-16) with two synthetic
accounts in a fresh group, a Kordi-operated key, and no @-mention anywhere:

| Step | Messages | PiP's action | Card |
| --- | --- | --- | --- |
| Proposal | organizer proposes two options, peer picks one, organizer locks it | propose, then confirm; posts one message | revision 3, `confirmed`, organizer yes, peer pending |
| Partial decline | peer: "I can't make it on Saturday anymore" | rsvp no on the peer's behalf; posts one message | revision 4, still `confirmed`, peer no |
| Organizer cancels | organizer: "cancel lunch for everyone" | cancel; posts one message | revision 5, `canceled` |

Every step produced exactly one cloud run, about 20 seconds after the last
message; no run failed and PiP's own messages did not queue a further run.
Manual runner calls also confirmed that a member's own call may not act for
another member while PiP's run may, inside its own conversation only.

Two failure modes found and fixed during validation: the model sends optional
strings as `""` (an empty `existingEventId` is now a new card, not a missing
one), and it may send ambiguous times (`startAt`/`endAt` now require an RFC
3339 offset and return a 400 that explains the format).

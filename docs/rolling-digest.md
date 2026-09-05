# Rolling digest and calendar

Digest is a single account-private report, not a Daily/Weekly selector. Desktop and iOS read the same Cloud snapshot and calendar. The interface uses sentence-case headings, source-linked contact attribution, a persistent Brief / Next steps / Calendar layout, and explicit confirmation before creating tasks or events.

## Data and generation

Opening the authenticated `/v1/cloud/digest` endpoint enables the account's monitor. A five-second worker sweep compares authorized source content, session metadata, task state and calendar state. Only changed inputs enqueue a run, and an atomic account-row reservation prevents concurrent generations. Changes during a run are picked up after it finishes. The current snapshot and its evidence remain separate from the in-flight input.

Generation reuses Cloud provider-auth snapshots and the existing runner lease protocol. While generating a digest, the runner renews its lease every 40 seconds through the same source-revalidating running endpoint. Model generation has a ten-minute timeout so a stalled report does not hold a lease indefinitely. Digest run IDs are created only by the server. Their dedicated runner path has `search_sessions` and `read_session` over a frozen, account-authorized input. It never creates a sandbox or exposes shell, filesystem, messaging, task or calendar mutation tools. Strict structured output rejects missing/unknown sources, duplicate item IDs, unsupported kinds, invalid dates and unrelated owners. The previous source-backed open commitments are retained as context.

Aggregation uses canonical v2 membership and per-account message/session visibility. Sources are checked before a lease is returned, when a run starts, before publication and on cached reads. A changed or inaccessible source suppresses the affected cached snapshot until it can be rebuilt. Completion does not create a chat message. Input, output and source evidence publish atomically.

Source work is bounded: the newest 500 candidate messages, up to 200 retained commitment references, approximately 100 KB of source payload, and up to 50 recent/upcoming calendar records. Truncation is shown as partial coverage. The initial sweep processes up to 20 eligible accounts per pass; a dedicated dirty-account queue is the next scaling step if this bound becomes a freshness bottleneck. This implementation does not claim unbounded historical recall or model entailment guarantees.

## Confirmed actions

- `/v1/cloud/digest/items/:id/task` rechecks sources, uses the existing session-task table and records stable conversion feedback. Repeated conversions reuse matching task identity rather than creating a second task. Edited due dates are recorded in the task summary, matching the existing task model.
- Suggestion dismissal is account-scoped and reversible.
- `/v1/cloud/calendar/events` stores private events independently of generated text. Updates/deletion require the current revision, so stale clients do not overwrite later edits. Chat-derived events retain source IDs; imported events retain external identity.
- The calendar connection action requests native EventKit read access and then lets the user choose device calendars, including any iCloud/Google calendars already configured in system accounts. This is a reviewed one-time import, not a new OAuth client, an invitation flow or bidirectional provider sync.
- ICS paste, file and HTTPS/webcal-link import use one shared ICAL.js adapter across desktop and iOS. Recurrence expansion, exclusions, all-day exclusive ends and included timezone definitions are supported. Unknown timezone definitions, malformed dates and limits surface import errors or warnings. Imports preserve stable identity and do not activate embedded alarms. Equal start/end timestamps are normalized to a start-only event before saving, including events returned by device calendars. Invalid date ranges are skipped individually and reported alongside imported and duplicate counts. Connection failures stop the batch with a partial-progress message; retries read current event identities to avoid duplicates.

## Reminders

The server has a durable per-event/revision/device APNs delivery ledger using the existing push configuration and registered active devices. Delivery is fenced by the current event revision, source access, device/session validity, retry limits and a bounded expiration window. Lock-screen text is generic, and tapping a reminder routes iOS to the confirmed calendar event.

When APNs is configured, iOS uses remote delivery and cancels its local fallback queue to avoid scheduling both paths. Without APNs, iOS schedules native local notifications. macOS schedules native notifications directly. Local queues schedule the next 60 future reminders and reconcile on calendar refresh; the OS can deliver scheduled entries while the app is closed, but newly created remote events cannot enter a closed local-only client's queue until it syncs again. Notification permission remains separate from calendar permission and event creation.

Changing accounts or signing out cancels the previous account's local reminders. Editing/removing an event invalidates its old reminder revision. APNs enqueue success is not proof of display; OS settings and connectivity still control delivery.

## Validation

Focused checks cover source/owner validation, revoked membership, no chat-message fanout, atomic snapshot/evidence persistence, read-only runner tools, account-isolated client requests, month boundaries, all-day/overnight events, ICS recurrence and duplicate identity. An isolated SQL fixture test uses `KORDI_DIGEST_TEST_DATABASE_URL`; never point it at a shared or product database.

Useful commands from the repository root:

```sh
pnpm --dir app/desktop typecheck
pnpm --dir app/desktop lint
pnpm --dir app/desktop test:unit
pnpm --dir app/desktop build
cargo test -p kordi-cloud-server digest::tests
cargo test -p kordi-cloud-agent-runner digest
cargo check -p kordi-desktop --no-default-features
```

Native iOS validation uses the `Kordi Beta` scheme. Real provider generation, EventKit permission prompts and APNs delivery require an authorized isolated environment and configured test accounts; compilation and fixture tests do not substitute for that end-to-end validation.

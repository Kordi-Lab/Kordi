# Rolling digest and calendar

Digest is a single account-private report, not a Daily/Weekly selector. Desktop and iOS read the same Cloud snapshot and calendar. The interface uses sentence-case headings, source-linked contact attribution, a persistent Brief / Next steps / Calendar layout, and explicit confirmation before adding calendar events. Next steps shows dismissible AI suggestions for the viewer, not Agent execution history or the generated commitments list. Commitments remain internal generation context and are not presented as the user's task inbox.

## Data and generation

Opening the authenticated `/v1/cloud/digest` endpoint enables the account's monitor and initializes its language and timezone. Later reads and refreshes preserve these shared preferences: opening or refreshing on another device must not reinterpret relative dates. The response includes the account's generation timezone; calendar displays use the viewing device's timezone. A five-second worker sweep compares authorized source content, session metadata, task state and calendar state. Only changed inputs enqueue a run, and an atomic account-row reservation prevents concurrent generations. Changes during a run are picked up after it finishes. The current snapshot and its evidence remain separate from the in-flight input.

Generation reuses Cloud provider-auth snapshots and the existing runner lease protocol. While generating a digest, the runner renews its lease every 40 seconds through the same source-revalidating running endpoint. The generation and lease-renewal loop has a ten-minute timeout so a stalled report does not hold a lease indefinitely. Digest run IDs are created only by the server. Their dedicated runner path has `search_sessions` and `read_session` over a frozen, account-authorized input. The first model call includes the complete bounded source set so coverage does not depend on which sessions the model chooses to read. It never creates a sandbox or exposes shell, filesystem, messaging, task or calendar mutation tools. Strict structured output rejects missing/unknown sources, duplicate item IDs, unsupported kinds, invalid dates and unrelated owners. The previous source-backed open commitments are retained as context. Claims tied to edited or removed source versions are discarded before entering the next generation.

Aggregation uses canonical v2 membership and per-account message/session visibility. Sources are checked before a lease is returned, when a run starts, before publication and on cached reads. A changed or inaccessible source suppresses the affected cached snapshot until it can be rebuilt. Completion does not create a chat message. Input, output and source evidence publish atomically.

After the first generation, the model receives only added/changed sources, tasks and calendar records, explicit removed IDs, the previous structured report and a compact event identity/time index for matching reschedules. Unchanged raw message history is omitted. Scoped observation remains available for missing context. The model returns item upserts and `removedItemIds`; the server merges and validates the complete report before atomic publication. An unchanged refresh does not spend another model call. Missing compatible baseline data requires one full generation. The Runner marks incremental output so an older API rejects a patch instead of publishing it as a complete report during rollback.

Agent sources retain the actual sender Agent ID, current configured name, and owner name. Default Agents also use their configured avatar. Names are resolved within the message sender's ownership scope; a mentioned target is not treated as the source author. Human and Agent authors remain separate even when they share an owner.

Source work is bounded: the newest 500 candidate messages, up to 200 retained commitment references, approximately 100 KB of source payload, and up to 50 recent/upcoming calendar records. Truncation is recorded in the API response `partial` field; the iOS and macOS pages do not display a coverage notice. The initial sweep processes up to 20 eligible accounts per pass; a dedicated dirty-account queue is the next scaling step if this bound becomes a freshness bottleneck. This implementation does not claim unbounded historical recall or model entailment guarantees.

## Confirmed actions

- `/v1/cloud/digest/items/:id/task` rechecks sources, uses the existing session-task table and records stable conversion feedback. Repeated conversions reuse matching task identity rather than creating a second task. Edited due dates are recorded in the task summary, matching the existing task model.
- Desktop Brief entries and suggestions can be dismissed independently. Dismissal is saved for the account and can be restored from the corresponding desktop view. iOS honors dismissed Brief entries and restores only current suggestions from its suggestion controls; it does not restore Brief entries or stale feedback from that action.
- `/v1/cloud/calendar/events` stores private events independently of generated text. Updates/deletion require the current revision, so stale clients do not overwrite later edits. Chat-derived events retain source IDs; imported events retain external identity. The account calendar has an explicit 1,000-event capacity; additions beyond it are rejected rather than saved outside the readable range.
- Calendar proposals can identify an exact existing event and revision with `calendarAction`, `existingEventId` and `existingEventRevision`. Reschedules and cancellations open a review screen; they never execute from generation. Ambiguous targets remain questions. The current scope is one occurrence, not bulk editing/deleting a series. Source calendars and invitations are never changed.
- Explicit natural-language recurrence is proposed as daily, weekly, monthly or yearly, with an interval, optional ISO weekdays, an IANA timezone, and a count or inclusive local end date. Missing end conditions remain for review. `/v1/cloud/calendar/series/preview` is read-only; `PUT /v1/cloud/calendar/series/:id` saves a confirmed finite series atomically, within 250 occurrences, five years and the account capacity. Stable identities make retries idempotent without overwriting edited or recreating individually removed occurrences. There is no unbounded rolling expansion or whole-series editor.
- Timed events store canonical UTC instants. Each device renders its local equivalent; recurrence keeps the original meeting timezone's wall clock across DST. Spring-forward gaps reject the preview rather than silently shifting the meeting; ambiguous future autumn times use PostgreSQL's standard-time interpretation, while the reviewed anchor instant is retained. All-day dates retain their date and exclusive end, independent of viewing timezone.
- Related HTTP(S) links, including Zoom, come from cited source messages, not invented model descriptions. They are retained on saved events and displayed as direct links on both platforms. Cards do not fetch previews or open meeting links automatically.
- The calendar connection action requests native EventKit read access and then lets the user choose device calendars, including any iCloud/Google calendars already configured in system accounts. This is a reviewed one-time import, not a new OAuth client, an invitation flow or bidirectional provider sync.
- ICS paste, file and HTTPS/webcal-link import use one shared ICAL.js adapter across desktop and iOS. Recurrence expansion, exclusions, all-day exclusive ends and included timezone definitions are supported. Unknown timezone definitions, malformed dates and limits surface import errors or warnings. Imports preserve stable identity and do not activate embedded alarms. Equal start/end timestamps are normalized to a start-only event before saving, including events returned by device calendars. Invalid date ranges are skipped individually and reported alongside imported and duplicate counts. Connection failures stop the batch with a partial-progress message; retries read current event identities to avoid duplicates.

## Reminders

The server has a durable per-event/revision/device APNs delivery ledger using the existing push configuration and registered active devices. Delivery is fenced by the current event revision, source access, device/session validity, retry limits and a bounded expiration window. Lock-screen text is generic, and tapping a reminder routes iOS to the confirmed calendar event.

When APNs is configured, iOS uses remote delivery and cancels its local fallback queue to avoid scheduling both paths. Without APNs, iOS schedules native local notifications. macOS schedules native notifications directly. Local queues schedule the next 60 future reminders and reconcile on calendar refresh; the OS can deliver scheduled entries while the app is closed, but newly created remote events cannot enter a closed local-only client's queue until it syncs again. Notification permission remains separate from calendar permission and event creation.

Changing accounts or signing out cancels the previous account's local reminders. Editing/removing an event invalidates its old reminder revision. APNs enqueue success is not proof of display; OS settings and connectivity still control delivery.

## Validation

Focused checks cover source/owner validation, revoked membership, no chat-message fanout, atomic snapshot/evidence persistence, delta merging, read-only runner tools, review-before-write, account-isolated client requests, month boundaries, all-day/overnight events, DST recurrence and duplicate identity. An isolated SQL fixture test uses `KORDI_DIGEST_TEST_DATABASE_URL`; never point it at a shared or product database.

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

# AI Session Digest implementation plan

Tracks [Kordi issue #958](https://github.com/Kordi-Lab/Kordi/issues/958).

## Outcome

Add an account-level Digest destination that turns accessible session history into sourced **daily and weekly reports**, extracted commitments, and clearly separated proactive suggestions. Reports are cached, permission-aware, refreshed manually or by a backend monitor after each 100 new eligible messages, and read-only until the user explicitly confirms creation of a Kordi task.

## Repository findings

- The desktop shell routes top-level destinations through `NavId`, `navItems`, `WorkspaceSidebar`, `MainContentSwitch`, and `useAppLayoutState`.
- `canonicalStore` plus `createCanonicalSessionReadModel` already normalize session metadata, messages, participants, task activities, context snapshots, and visibility for the desktop UI.
- `buildTaskActivityDashboard` extracts planning and execution activity from agent turns, while Cloud session activity provides durable task/artifact records per session.
- The Cloud client has per-peer message reads, account-scoped sync events, per-session visibility, pins, forks, activity, and scheduled-task endpoints. It does not expose a complete, permission-filtered cross-session digest API.
- The hosted server already centralizes session membership in `cloud_session_participants` and `caller_can_access_cloud_session`.
- Hosted AI work already flows through `cloud_agent_fallback_runs`, the runner lease API, provider-auth snapshots, and `cloud-agent-runner`. A digest should extend this execution path with a non-chat purpose instead of embedding model calls in the HTTP server.
- The worktree contains active unrelated changes across the desktop app, Cloud server, and iOS client. The UI concept is therefore implemented first as an isolated design preview.

## Product shape

The selected composition is **Morning Brief**:

1. A Daily / Weekly switch moves between two independently addressable cached reports.
2. A concise cross-session report establishes what changed.
3. A quiet monitor strip shows freshness, eligible-message progress, and the next automatic update boundary.
4. Three cited highlights expose the most important outcomes.
5. A chronological evidence timeline lets users inspect source messages in place.
6. A `Do next` ledger separates extracted commitments from AI suggestions.
7. Scope, generation time, coverage, and partial failures remain visible.

The feature should initially be global to the signed-in account with optional filters for time range and session scope. Workspace-specific presets can be added without changing the digest model.

## Data contract

```ts
type DigestSnapshot = {
  digestId: string;
  period: 'daily' | 'weekly';
  status: 'queued' | 'running' | 'ready' | 'partial' | 'failed';
  range: { start: string; end: string; preset: string };
  scope: { sessionIds: string[]; excludedSessionIds: string[] };
  coverage: { includedSessions: number; includedMessages: number; omittedSessions: number };
  generatedAt: string | null;
  summary: string;
  highlights: DigestHighlight[];
  timeline: DigestTimelineItem[];
  commitments: DigestCommitment[];
  suggestions: DigestSuggestion[];
  warnings: Array<{ code: string; message: string }>;
  freshness: {
    sourceCursor: number;
    eligibleMessagesAtGeneration: number;
    pendingEligibleMessages: number;
    refreshThreshold: 100;
    trigger: 'manual' | 'daily_boundary' | 'message_threshold';
  };
};

type DigestSourceRef = {
  sessionId: string;
  messageId: string;
  sessionTitle: string;
  excerpt: string;
  createdAt: string;
};
```

Every highlight, commitment, and suggestion carries one or more `DigestSourceRef` values. Suggestions also carry a short `reason` and remain distinguishable from commitments in both the API and UI.

## Backend phases

### Phase 1 — snapshot and generation API

- Add `cloud_digest_snapshots` with owner account, requested range/scope, status, model route, coverage metadata, structured result JSON, warnings, timestamps, and soft-delete time.
- Add `cloud_digest_source_refs` only if source-level permission revocation or analytics require normalized rows; otherwise keep immutable refs inside the snapshot JSON for the MVP.
- Add authenticated routes:
  - `POST /v1/cloud/digests`
  - `GET /v1/cloud/digests/:digest_id`
  - `GET /v1/cloud/digests/latest?period=daily|weekly&scope=...`
  - `GET /v1/cloud/digests/freshness?scope=...`
  - `DELETE /v1/cloud/digests/:digest_id`
- Select sessions on the server from current account participation and current visibility rules. Hidden, deleted, inaccessible, and out-of-range sessions are excluded before prompt construction.
- Cap source size by ranking meaningful messages, existing task/activity records, decisions, and recent unresolved threads. Return explicit coverage warnings when the cap omits eligible content.
- Treat summary, highlights, timeline evidence, commitments, suggestions, coverage, and generation metadata as one immutable snapshot version; clients never mix fields from different versions.

### Phase 2 — runner integration

- Add a `run_purpose` such as `chat | scheduled | digest` to the existing fallback-run model.
- Lease digest jobs through the existing authenticated runner and provider route.
- Use a versioned structured prompt that returns schema-validated JSON, not Markdown.
- On completion, validate source IDs against the frozen eligible-input set, persist the snapshot, and emit an account-scoped `digest.updated` sync event.
- Never post the generated digest as a chat message.

### Phase 3 — durable monitor and cadence

- Add `cloud_digest_refresh_state` keyed by owner account and scope hash with the last consumed sync cursor, last generated cursor, pending eligible-message count, 100-message threshold, active lease, and next local-day boundary.
- Consume the existing account-scoped `cloud_sync_events` stream for `message.upsert` events instead of adding model work to the hot `cloud_messages` write path.
- Deduplicate by `(account_id, message_id)`, resolve the message's session against the current digest scope, and increment only messages the account can currently access.
- When `pending_eligible_messages >= 100`, atomically acquire a refresh lease, freeze the cutoff cursor, and enqueue one coalesced runner batch that regenerates both Daily and Weekly snapshots. Carry any messages above the boundary into the next counter.
- Regenerate Daily (current local day) and Weekly (trailing seven days) at the local day boundary even when traffic stays below 100, so low-volume accounts remain current. Manual refresh remains available and only replaces the requested period snapshot.
- Use an idempotency key derived from `(account_id, scope_hash, cutoff_cursor, period)` and a single-flight lease so retries, duplicate sync events, or multiple server instances cannot create regeneration storms.
- Permission or membership changes mark affected snapshots dirty immediately. Read-time redaction remains the final protection if a source becomes inaccessible before regeneration finishes.
- Publish `digest.updated` only after both requested snapshots and their freshness state commit successfully.

### Phase 4 — action conversion

- Add `POST /v1/cloud/digests/:digest_id/commitments/:item_id/task`.
- Require explicit confirmation and an idempotency key.
- Reuse the Cloud session activity/task model where possible; do not create an unrelated to-do store.
- Track dismissal and task-conversion feedback independently from the immutable generated snapshot.

## Desktop phases

### Phase 1 — destination and read-only digest

- Extend `NavId` and `navItems` with `digest` using a restrained agent-violet identity cue.
- Add `DigestPage`, `useCloudDigest`, and a pure `digestClient` beside the existing Cloud clients.
- Route the page through `MainContentSwitch` as a single-workspace destination with no chat session or detail rails.
- Implement Daily / Weekly switching, report, freshness monitor, cited highlights, evidence expansion, commitments, suggestions, filters, refresh, loading, empty, partial, and error states.
- Keep the current cached report readable while automatic or manual updates run; atomically swap the complete snapshot only when `digest.updated` arrives.
- Track Daily and Weekly freshness independently for manual refresh. Only the 100-message batch and local-day boundary commit both snapshots together.
- Navigate source links back to the relevant chat and message using the existing transcript message-navigation path.

### Phase 2 — durable preferences and notifications

- Remember the selected Daily / Weekly period, time range, scope, and notification preference per account.
- Reuse the server's scheduling primitives for calendar boundaries, but keep digest generation and delivery distinct from ordinary reminder messages.
- Notifications remain optional; snapshot generation and freshness monitoring do not depend on notification opt-in.

## Permission and trust rules

- Re-evaluate access when generating the snapshot and again when opening a source link.
- A stored digest must not reveal an excerpt after the viewer loses access to its source; redact or omit that item at read time.
- Never imply full coverage when generation is partial.
- Count only permission-eligible, non-deleted messages toward the 100-message threshold; the UI must not describe the counter as all raw traffic.
- Keep the last valid report visible while a refresh is queued or running, and expose its age rather than replacing it with a full-page loading state.
- Preserve uncertainty for inferred owners, dates, and commitments.
- Do not create tasks, send messages, or trigger agents without a separate user action.
- Keep generated snapshots account-private in the MVP.

## Verification

- Server tests for membership filtering, hidden/deleted sessions, local-day and trailing-seven-day boundaries, source-ID validation, partial coverage, threshold counting, deduplication, cursor recovery, lease contention, idempotency, and revoked access.
- Runner tests for strict schema parsing, invalid-source rejection, retry behavior, and completion without chat-message fanout.
- Desktop unit tests for Daily / Weekly view mapping, freshness progress, commitment/suggestion distinction, source navigation, automatic/manual refresh races, stale-report continuity, and error recovery.
- Visual tests at the default 1460×900 window, minimum 980×680 window, light/dark themes, keyboard navigation, increased contrast, and reduced motion.
- Performance budget: initial cached render under one frame; generation work remains asynchronous; long evidence lists are virtualized or progressively disclosed.

## Suggested delivery slices

1. Read-only desktop page backed by Daily / Weekly fixture contracts.
2. Permission-filtered server aggregation with deterministic fake generation in tests.
3. Hosted runner generation plus manual `digest.updated` sync.
4. Durable sync-event monitor, 100-message coalescing, and local-day refreshes.
5. Source navigation and partial-coverage hardening.
6. Explicit task conversion and optional notifications.

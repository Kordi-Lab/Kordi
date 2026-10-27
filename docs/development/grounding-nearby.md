# Grounding: Nearby people

Contract for issue #2100. Nearby people is part of Grounding (internal name `common_ground`). It sits under Pair, next to Tap, QR and the pair code; it is not a new destination. The product design is in [common-ground.md](../common-ground.md) and the interactive proposal is in `docs/design-previews/grounding-nearby/`.

## Summary

- A person turns on Nearby, consents, and picks one Grounding profile to share. While it is on, they can see other participants within a range and minimum match score, and those participants can see them.
- Their iPhone sends its location, also in the background. Location counts as current for 30 minutes after it was taken. The Mac reads the same results and settings but never sends a location in this version.
- Requests ("needs") describe who they want to meet. A request has no end, or a time window that ends within 7 days. Requests can be edited, paused and deleted.
- The server checks nearby participants against requests and against the match score, and sends an alert to the person's iPhones. Alerts are deduplicated and capped per day.
- Turning Nearby off or pausing it hides the person, stops searching and stops alerts at once. The server checks this on every request and again before each alert is sent.

## Names

| Thing | Name |
|---|---|
| Server module | `bridges/cloud-server/src/common_ground/nearby/` |
| Routes | `/v1/cloud/common-ground/nearby…` |
| Capability | `commonGroundNearbyVersion: 1` in `GET /v1/cloud/auth/capabilities`, present when `commonGroundVersion` is |
| Request checks (runs) | prefix `cg_need_` (the runner already runs every `cg_` run as one completion with no tools) |
| Realtime hints | `common_ground.nearby.updated` (settings, requests or results changed), `common_ground.nearby.alert` (an alert was delivered) |
| Push type | `notification_type: "common_ground_nearby"` |
| Request ids | `cgn_` + 32 hex; alert ids `cgna_` + 32 hex |

## Participation

Participation is one rule. It is evaluated live, in SQL, on every nearby path: search, person, match, the alert queue and alert delivery. Room members and pairings are never consulted, and nearby never creates a room or pairing link.

An account **participates** when all of these hold:

1. Its nearby row has `enabled = true` and a recorded `consented_at`.
2. `paused_until` is null or in the past.
3. Its chosen profile still exists, belongs to it, has a built card (`built_at IS NOT NULL`) and has `sharing_enabled = true`.

An account is **present** when it participates and has a location row from a device that is not revoked, with `fresh_until > now()`.

Two accounts see each other through nearby when both are present, their distance is at most 25 km, and they are different accounts. (When a block list lands on main, a block in either direction also hides both ways. There is no block table today.)

Reciprocity means both people take part. It does not mean they use the same filters: each viewer's own range and minimum score decide what that viewer sees.

- A viewer who does not participate gets `409 common_ground_nearby_off` from search, person, match and request-check paths. Their pending alerts are invalidated and they get none.
- A viewer who participates but is not present gets `409 common_ground_nearby_no_location` from search, person and match.
- A person who stops participating or stops being present disappears from everyone's results at once. Their actions toward others stop working through nearby.

### Turning off, pausing, signing out

- `enabled: false`: deletes all of the account's location rows, invalidates its pending alerts and the pending alerts about it, and clears `dirty_at`. Settings and requests are kept for next time.
- Pause (`pausedUntil` in the future, at most 7 days): the same deletions. Participation resumes automatically when `pausedUntil` passes. The person is visible again after the next location post.
- Sign-out (`POST /v1/cloud/auth/logout`) deletes the location row of that session's device. Revoking a device deletes its location row in the same transaction.
- The iPhone deletes its location (`DELETE nearby/location`) when location access is withdrawn, when the person turns off background alerts and leaves the app, and before signing out. If iOS never runs the app again, the location goes stale within 30 minutes.

## Location

- Stored per device (`device_id`) with latitude and longitude rounded to 3 decimals (about 110 m). Precise coordinates are never stored, logged or returned.
- `POST nearby/location` takes `{latitude, longitude, accuracy, capturedAt}` (accuracy in meters) and answers `200 {location: {capturedAt, freshUntil, fresh}}`. A reading older than the device's stored one does not replace it.
- `POST nearby/location` is accepted only from a participating account (`409 common_ground_nearby_off` otherwise). These are rejected:
  - `capturedAt` older than 10 minutes or more than 60 s in the future (`422 common_ground_nearby_invalid_location`);
  - accuracy worse than 2,000 m (`422 common_ground_nearby_inaccurate`);
  - a latitude or longitude out of range (`422 common_ground_nearby_invalid_location`).
- `fresh_until = captured_at + 30 min`. The window is the setting `KORDI_COMMON_GROUND_NEARBY_FRESH_SECONDS` (default 1800), read once when the server starts. The database tests make a location stale by moving its row back in time, and run one sweep with `nearby::sweep_once`.
- The account's location is its most recent fresh row by `captured_at`.
- Each post marks the account dirty for the alert sweep.
- Limit: 120 posts per account per hour (`rate_limited`, 429 with `Retry-After`).

### Distances

Other people's distance is returned only as a band:

| `distance.maxMeters` | `distance.minMeters` | Label |
|---|---|---|
| 500 | 0 | Under 500 m |
| 1000 | 500 | Under 1 km |
| 2000 | 1000 | 1–2 km |
| 5000 | 2000 | 2–5 km |
| 10000 | 5000 | 5–10 km |
| 25000 | 10000 | 10–25 km |

A distance is in the smallest band whose `maxMeters` is at least the distance. The range filter takes one of the `maxMeters` values and keeps people whose distance is at most that value. A distance exactly on the edge counts as inside.

Distance is the haversine distance between the two rounded points (Earth radius 6,371,000 m). SQL prefilters present people with a bounding box around the viewer (longitude wraps at the antimeridian) and returns the nearest 500 by approximate distance; the server computes the exact distance and applies the range. No extension is needed.

## Settings

`GET nearby` returns the viewer's settings and status:

```json
{
  "enabled": true,
  "participating": true,
  "pausedUntil": null,
  "consentedAt": "2026-10-26T09:00:00Z",
  "profileId": "cgp_…",
  "openTo": ["Coffee chat"],
  "range": 2000,
  "minScore": 50,
  "alerts": { "requests": true, "matches": true, "matchMinScore": 85, "maxPerDay": 3 },
  "location": { "capturedAt": "…", "freshUntil": "…", "fresh": true },
  "freshSeconds": 1800
}
```

- An account with no row gets the defaults:
  - `enabled: false`;
  - the default profile;
  - `range: 2000`, `minScore: 0`;
  - alerts on for requests and matches, `matchMinScore: 85`, `maxPerDay: 3`;
  - `location: null`.
- `participating` is the live result of the participation rule.
- `location` is the account's most recent row, fresh or not, or null.

`PUT nearby` writes only the fields in its body:

- `enabled: true` requires `consent: true` in the same body whenever the account is not already enabled. Otherwise it returns `409 common_ground_nearby_consent_required`. Consent sets `consented_at`.
- `profileId` must be one of the viewer's profiles (`404 common_ground_profile_not_found`). Enabling with a profile that has no built card returns `409 common_ground_no_card`; with sharing off it returns `409 common_ground_sharing_off`.
- `pausedUntil`: an ISO time at most 7 days ahead, or null to resume.
- `openTo`: up to 5 entries of up to 30 characters, trimmed and deduplicated (case-insensitive). The clients offer Coffee chat, Collaborating, Advice and Hiring, plus typed entries. This is the person's stated current willingness; others see it on their nearby entry.
- `range` must be a band value. `minScore` must be one of 0, 50, 70 or 85.
- `alerts.matchMinScore` must be one of 50, 70 or 85. `alerts.maxPerDay` must be one of 1, 3 or 10.
- Any other value returns `422 common_ground_nearby_invalid_settings`.
- The response is the same shape as `GET`.
- Every accepted `PUT` sends `common_ground.nearby.updated` to the account. One that leaves the account enabled and not paused marks it dirty; turning off or pausing runs the deletions in [Turning off, pausing, signing out](#turning-off-pausing-signing-out) instead.
- A stored profile that was deleted leaves the setting enabled but not participating until the client sends a `profileId`.

`DELETE nearby/location` deletes the calling device's row, sends `common_ground.nearby.updated` and answers 204.

## Search

`GET nearby/people?range=&minScore=` uses the stored settings when a parameter is missing. A request with parameters does not change the stored settings.

```json
{
  "people": [
    {
      "person": { "accountId": "…", "name": "…", "handle": "…", "avatarUrl": "…", "profile": { "profileId": "…", "kind": "work", "name": "Work", "design": null, "icon": null } },
      "relationship": { "contact": false, "request": null, "requestId": null, "conversationId": null },
      "distance": { "minMeters": 0, "maxMeters": 500 },
      "openTo": ["Coffee chat"],
      "status": "ready",
      "score": 92,
      "headline": "Both build memory for agents",
      "requests": [{ "needId": "cgn_…", "text": "Someone founding a startup" }]
    }
  ],
  "matching": 2,
  "location": { "capturedAt": "…", "freshUntil": "…", "fresh": true }
}
```

- **Candidates:** present accounts within `range`, excluding the viewer.
- **Filtering:**
  - A candidate with a stored match between the two nearby profiles at the current card revisions is listed when `score >= minScore`.
  - A candidate without one is counted in `matching`. They are listed with `status: "matching"` and null score only when `minScore` is 0.
  - Candidates whose match run failed, or who cannot be matched because the viewer's matching budget is spent, are listed only when `minScore` is 0, with `status: "failed"`. The search itself never answers 429.
- **Order:**
  1. people who meet at least one of the viewer's active requests;
  2. then by score, high to low;
  3. then by distance band;
  4. then by name.
  Up to 50 people are returned.
- **`requests`** lists the viewer's active requests whose range covers the person and that the person meets (see [Requests](#requests)). Only the request id and text are returned, and only to their owner.
- **Matching:** search queues matching for the nearest unmatched candidates through the existing `matching::store::queue_matches` (no room, the two nearby profiles). It is charged to the existing matching budget. Search also queues request checks for active requests that lack a current verdict, for the candidates within each request's range.
- **Updates:** completion of either kind of run sends `common_ground.nearby.updated` to the viewer so clients refetch.
- **Errors:** `409 common_ground_nearby_off`, `409 common_ground_nearby_no_location`, `422 common_ground_nearby_invalid_settings` for a bad parameter.

`GET nearby/people/:accountId` re-checks the pair rule live and returns 404 `common_ground_person_not_found` when it fails. Otherwise it returns:

- the entry above;
- `card` (shared topics: `workingOn`, `interests`, `canHelp`, `lookingFor`, with hidden topics removed);
- `requests` with their checks (see below), for active requests whose range covers the person;
- the match result when stored: `score`, `headline`, `shared`, `youBring`, `theyBring`, `nextStep`. When it is not stored, `status: "matching"` and a run is queued.

Opening it does not set `opened_at` on the stored match and adds no room or pairing. Recent lists every match with `opened_at`, so this is what keeps a person out of Recent through nearby alone.

Add, Message and Meet (`people/:id/contact|chat|meet`) also accept a person who is visible through nearby at that moment. `actions::require_visible` falls back to the live nearby pair rule when no room or pairing link exists.

## Requests

```json
{
  "needId": "cgn_…",
  "text": "Coffee with a Fudan or SJTU alum",
  "range": 1000,
  "startsAt": "2026-10-26T15:00:00Z",
  "endsAt": "2026-10-26T18:00:00Z",
  "paused": false,
  "status": "active",
  "revision": 2,
  "createdAt": "…",
  "updatedAt": "…"
}
```

- **Routes:**
  - `GET nearby/needs`: `{needs: [...]}`, newest first.
  - `POST nearby/needs`: 201 with the request. `range` defaults to the account's nearby range.
  - `PUT nearby/needs/:id`: writes only the fields in the body; `startsAt` or `endsAt` null clears it.
  - `DELETE nearby/needs/:id`: 204.
  - A request owned by someone else is 404 `common_ground_nearby_need_not_found`.
- **Limits:** up to 10 requests per account (`409 common_ground_nearby_too_many_needs`). `text` is 1 to 200 characters after trimming. `range` is a band value.
- **Time window:** `endsAt` is null (no end) or a time after now and at most 7 days ahead. `startsAt`, if set, is before `endsAt`. Anything else is `422 common_ground_nearby_invalid_need`.
- **Status:**
  - `paused` when paused;
  - else `ended` once `endsAt` has passed;
  - else `scheduled` before `startsAt`;
  - else `active`.
  Only `active` requests produce checks, appear in search `requests` and produce alerts. Ended requests stay listed until deleted.
- **Editing:**
  - Any change to `text`, `range`, `startsAt` or `endsAt` increments `revision`.
  - A new revision makes every stored verdict for the request obsolete (they carry `need_revision`) and invalidates the request's pending alerts.
  - Pausing or deleting the request also invalidates its pending alerts.
  - Each change marks the account dirty.

### Checking a request

Request checks are `cg_need_` runs owned by the System agent service, like matching. Each run checks one request revision against up to 8 candidates. Limits:

- one open run per request revision (15 minutes open, 2 minutes after a failure, as for matching), so an edit can be checked at once;
- 30 runs per account per hour.

The prompt holds only the request text and, for each candidate under an opaque reference (`p1`, `p2`, …), the material that candidate chose to share:

- the shared profile's name and focus line;
- the four topic lists without hidden topics;
- their `openTo`.

It never includes account ids, names, contact details, locations or the candidate's own requests.

The model splits the request into at most 4 conditions and answers, per candidate and condition (a reply without conditions, with more than 4, or naming none of the candidates fails the run with `invalid_output`; a candidate it leaves out gets `unknown` for every condition):

```json
{
  "conditions": ["Is a Fudan or SJTU alum", "Wants a coffee chat"],
  "people": [
    {
      "ref": "p1",
      "checks": [
        { "condition": 0, "verdict": "met", "kind": "affiliation", "evidence": "Fudan University" },
        { "condition": 1, "verdict": "met", "kind": "willingness", "evidence": "Coffee chat" }
      ]
    }
  ]
}
```

`verdict` is `met`, `unknown` or `not_met`. `kind` is `interest`, `work`, `affiliation` or `willingness`.

The server validates every `met` and downgrades it to `unknown` when its evidence does not hold:

- `interest`: the evidence must equal (after folding case and spacing) a topic on the candidate's shared card.
- `work`: it must equal a Working on topic.
- `affiliation`: it must appear as whole words in the shared profile's name or focus line. Card topics alone are not accepted because they do not distinguish interest from affiliation.
- `willingness`: it must equal one of the candidate's `openTo` entries.

A shared topic alone therefore never proves willingness, and an interest never proves an affiliation. An affiliation found in the profile name or focus line must appear there as whole words. A `met` that fails validation keeps its kind and loses its evidence. A candidate **meets** a request only when every condition is `met` after validation.

The stored checks are validated again against the candidate's current material whenever they are read, because `openTo`, the profile name and the focus line can change without a new card revision.

**Storage:** verdicts go in `cloud_common_ground_nearby_verdicts`, keyed by request and the candidate's profile, with the request revision and the candidate's card revision. A verdict is current only while both revisions are unchanged.

**What the request owner sees:** `GET nearby/people/:id` returns `requests: [{needId, text, met, checks: [{condition, label, verdict, kind, evidence}]}]` for each active request with a current verdict; `label` is the condition's text. Evidence is a label from the candidate's shared card, profile or `openTo`, which the viewer can see anyway, and is null unless the check is `met`.

## Alerts

A sweep worker runs every 30 seconds (`KORDI_COMMON_GROUND_NEARBY_SWEEP_SECONDS`) when Grounding is available. It first invalidates expired pending alerts, then claims up to 20 dirty accounts at a time (`UPDATE … SET dirty_at = NULL … RETURNING`) until none are left, then delivers up to 100 pending alerts.

For each claimed account X, it finds the accounts Y that X can see through nearby. For each direction (recipient R, other O) in (X, Y) and (Y, X):

1. **Request alerts:** when R has `alerts.requests` on, for each active request of R whose `range` covers the distance:
   - a current verdict that meets the request queues a `need` alert;
   - a missing verdict queues a request check.
2. **Match alerts:** when R has `alerts.matches` on and the distance is within R's `range`:
   - a current stored match with `score >= alerts.matchMinScore` queues a `match` alert;
   - a missing match queues matching through `queue_matches`.
3. **Deduplication** (an invalidated alert never reached anyone and does not count):
   - a `need` alert is unique per (recipient, other account, request, request revision);
   - a `match` alert is skipped when one for the same pair was created in the last 7 days;
   - a person who already produced a request alert for R in the last 24 hours does not also produce a match alert.

Run completions mark the recipient dirty, so the next sweep picks up new verdicts and matches.

**Delivery** happens in the same sweep, oldest pending first. Before sending, it re-checks:

- both accounts still see each other through nearby (participation, presence, distance), and O still shares the same profile;
- the recipient still has that kind of alert on;
- for a `need` alert:
  - the request is still `active`, at the same revision, and its range still covers the distance;
  - the verdict is still current and still meets;
- for a `match` alert, the distance is within R's `range`, and `matchMinScore` and the stored score still hold;
- R has had fewer than `alerts.maxPerDay` delivered alerts in the last 24 hours, and none in the last 10 minutes.

Outcomes:

- A failed participation, request or verdict check marks the alert `invalidated`, with the reason `off`, `paused`, `not_visible`, `profile_changed`, `alerts_off`, `need_changed`, `need_paused`, `verdict`, `score` or `expired`.
- A failed frequency check marks it `suppressed` (reason `limit`); it is never sent late.
- A pending alert older than 15 minutes is `invalidated`.
- A sent alert is `delivered`, and `common_ground.nearby.alert` (`{alertId, kind, otherAccountId, needId}`) goes to R. The push is sent after the alert is stored as delivered.

**Push** goes to R's iOS devices, using the same token query as `notifications_proactive.rs`: message notifications enabled, device not revoked, an unrevoked and unexpired session.

```json
{
  "aps": { "alert": { "title": "Maya Chen is nearby", "body": "Someone founding a startup · Under 500 m" }, "sound": "default", "thread-id": "common-ground-nearby" },
  "notification_type": "common_ground_nearby",
  "account_id": "<recipient>",
  "other_account_id": "…",
  "alert_id": "cgna_…"
}
```

- The body for a match alert is "92% match · Under 500 m". The band is the one at delivery time.
- With previews off, the body is "Someone nearby matches what you're looking for" and the title is "Nearby".
- The collapse id is `cg-nearby-<other account>`.
- Dead tokens are deleted as in the other senders.
- No push service configured means alerts are still delivered in-app (hint only).

## Data

These tables are in one migration. Every account foreign key is `ON DELETE CASCADE`.

- `cloud_common_ground_nearby` holds one row per account:
  - `account_id` (primary key), `enabled`, `profile_id` (references profiles, `ON DELETE SET NULL`), `paused_until`, `consented_at`;
  - `open_to_json`, `range_m`, `min_score`;
  - `alert_requests`, `alert_matches`, `alert_match_min_score`, `alert_max_per_day`;
  - `dirty_at`, `updated_at`;
  - an index on `dirty_at` where not null.
- `cloud_common_ground_nearby_locations` holds one row per device:
  - `device_id` (primary key, references `cloud_devices` with cascade), `account_id`;
  - `latitude`, `longitude` (double, rounded), `accuracy_m`;
  - `captured_at`, `fresh_until`, `received_at`;
  - indexes on `fresh_until` and on `account_id`.
- `cloud_common_ground_nearby_needs` holds requests:
  - `need_id` (primary key), `account_id`, `text`, `range_m`, `starts_at`, `ends_at`, `paused`, `revision`;
  - `created_at`, `updated_at`;
  - an index on `account_id`.
- `cloud_common_ground_nearby_verdicts` holds request checks:
  - `need_id` (cascade), `other_profile_id` (cascade);
  - `need_revision`, `other_revision`, `met`, `checks_json`, `computed_at`;
  - primary key `(need_id, other_profile_id)`.
- `cloud_common_ground_nearby_need_runs` tracks check runs:
  - `run_id` (primary key), `need_id` (cascade), `need_revision`, `account_id`;
  - `candidates_json` (the snapshot the prompt was built from, cleared on finish);
  - `created_at`, `finished_at`, `failed_at`.
- `cloud_common_ground_nearby_alerts` holds alerts:
  - `alert_id` (primary key), `recipient_account_id`, `other_account_id`, `other_profile_id`;
  - `kind` (`need` or `match`), `need_id` (cascade, null for match), `need_revision`, `score`, `distance_max_m`;
  - `status` (`pending`, `delivered`, `suppressed` or `invalidated`), `reason`;
  - `created_at`, `delivered_at`;
  - a unique index for `need` alerts that are not invalidated on (recipient, other, need, revision);
  - an index on (recipient, `delivered_at`).

## Platforms

### iPhone

- **Entry:** a Nearby row in the Pair group on Grounding Home, after Tap and the pair code. It pushes the Nearby screen.
- **Location:**
  - "When In Use" on first turn-on.
  - "Always" only when background alerts are on, requested after When In Use is granted.
  - While Nearby is on and the app is open: one `requestLocation` on appear, then updates while the screen is visible, sending at most one location every 60 seconds.
  - In the background with Always: significant location changes, a 200 m region around the last point (exit triggers a new point and a new region), and a BGAppRefresh task that sends a point when iOS grants time.
  - No `location` background mode, so there is no continuous tracking.
- **Background status line:**
  - "Works in the background" with Always plus Background App Refresh;
  - "Only while Kordi is open" with When In Use or refresh off, plus Settings;
  - "Location access is off" when denied, plus Settings.
- **Withdrawal:** on denial, on an authorization downgrade while backgrounded, or on sign-out, the app sends `DELETE nearby/location` and stops monitoring.
- **Notification tap:** `common_ground_nearby` opens Grounding, then the nearby person.

### Mac

- **Entry:** a Nearby row in the Pair panel on Grounding Home. It opens the Nearby screen in the same column.
- Nearby uses the most recent fresh location from any signed-in device. The Mac and browser offer "Use this device’s location" to request a single foreground fix with OS/browser permission. Coordinates are rounded before posting through the same per-device route. No automatic desktop background tracking is started.
- People remains visible with explicit states for missing location, loading, paused search, errors, and no matches. Refresh results reloads settings, requests, and people without changing the filters.
- Help > Permissions & access includes Location, with an Allow action and recovery through Location Services settings. Opening the permissions panel only reads authorization; it does not request access or publish coordinates.
- Settings, requests, results, the person page and the actions work as on iPhone.
- Alerts appear in the list and through the realtime hint. In this version the Mac does not show Nearby system notifications.

## Limits that stay

- iOS decides when a suspended app runs. Significant-change and region events can arrive minutes late, and a force-quit app gets no background time. A person who stays in one place without opening Kordi stops being shown after 30 minutes. The status line and this document say so; the app does not promise uninterrupted discovery.
- Rounded coordinates and distance bands limit what a viewer learns. The post limit slows down someone who moves a fake location around to triangulate, but cannot rule it out.

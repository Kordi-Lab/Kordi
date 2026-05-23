# Cloud presence status design

## Parent issue

- Parent: #479 Keep agents reachable while owner device is offline
- Subissue purpose: establish reliable realtime user/device presence before implementing offline read-only agent fallback.

## Goal

Build a backend + desktop vertical slice for Cloud Edition presence:

- Track online/offline at the device level.
- Derive account-level presence from all active devices.
- Restrict presence visibility to accepted contacts.
- Provide an initial read API plus realtime updates.
- Show a minimal UI signal: a small green/gray light on avatars in Contacts and participant surfaces.

This subissue does not implement server-side read-only agent responses. It creates the presence foundation that later #479 fallback routing can trust.

## Non-goals

- No read-only fallback runtime.
- No provider credential snapshot work.
- No local tool capability gating.
- No public presence lookup by account ID.
- No status pills, "Online"/"Offline" labels, "last seen" text, or large team dashboard.

## Presence model

### Device-level source of truth

Each desktop device publishes presence for its authenticated cloud session:

- `online`: desktop has an active signed-in session and can publish heartbeats.
- `offline`: desktop explicitly signed out, closed, or pagehide/unload best-effort fired.
- `last_heartbeat_at`: server timestamp of the latest online/heartbeat write.
- `last_offline_at`: server timestamp of the latest explicit offline write.

A device is currently online when:

- it is not revoked,
- its latest state is `online`, and
- `last_heartbeat_at` is within the configured timeout window.

### Account rollup

An account is currently online when at least one non-revoked device is currently online. Otherwise it is offline.

The server emits account-level presence events only when the derived account status changes. Heartbeats that keep the rollup unchanged must not spam realtime listeners.

## Backend design

### Storage

Add a dedicated presence table instead of overloading `cloud_devices` registration fields:

- `device_id` primary key / foreign key to `cloud_devices`.
- `account_id` indexed for rollup queries.
- `state` constrained to `online` or `offline`.
- `last_heartbeat_at`.
- `last_offline_at`.
- `updated_at`.

The table is live state. Device registration remains in `cloud_devices`.

### Write API

Add authenticated endpoints for the current session device:

- `POST /v1/cloud/presence/online`
- `POST /v1/cloud/presence/heartbeat`
- `POST /v1/cloud/presence/offline`

All three infer `account_id` and `device_id` from the cloud session token. Clients cannot write presence for another device/account.

Write behavior:

- `online` creates/updates the device presence row, sets state online, updates heartbeat timestamp.
- `heartbeat` updates heartbeat timestamp and keeps state online.
- `offline` sets state offline and records offline timestamp.
- After each write, recompute account rollup before/after and emit an event if it changed.

### Read API

Add:

- `GET /v1/cloud/presence/contacts`

Response includes current account rollup status for:

- the signed-in account itself, and
- accepted contacts only.

Do not include pending request counterparties or arbitrary lookup results in this subissue.

Suggested response shape:

```json
{
  "accounts": [
    {
      "accountId": "acct_...",
      "status": "online",
      "updatedAt": "2026-05-23T...Z"
    }
  ]
}
```

### Realtime events

Broadcast an event when an account rollup changes:

- subject: `kordi.events.presence.account.<account_id>`
- payload: `{ accountId, status, updatedAt }`

Delivery rules:

- Deliver to the account itself.
- Deliver to accepted contacts of that account.
- Do not deliver to non-contacts or pending-only counterparties.

### Timeout handling

Use both explicit offline and heartbeat timeout:

- Explicit offline provides fast updates on normal close/logout.
- Timeout handles crash, sleep, network loss, and process kill.

A lightweight server sweeper should periodically find online device rows whose heartbeat is older than the timeout. For each affected account whose rollup changes, emit the same account presence event.

Configuration should use conservative defaults suitable for local tunnel previews:

- desktop heartbeat interval: around 20-30 seconds,
- server timeout: several missed heartbeats, around 75-120 seconds.

Exact values can be tuned during implementation, but the timeout must avoid flapping on brief tunnel stalls.

## Desktop design

### Presence publisher

Add a Cloud Edition desktop presence publisher that starts when a valid cloud session is active.

Behavior:

- Publish `online` after sign-in/session activation.
- Publish `heartbeat` on an interval while active.
- Publish `offline` on logout and best-effort pagehide/beforeunload.
- Stop heartbeat when session is cleared.
- Swallow transient publish failures and retry on the next heartbeat.

Avoid publishing offline during normal React effect remount cleanup. Only real logout/unload/pagehide should publish offline. This prevents the false-offline race found during previous #479 exploration.

### Presence store

Add a small frontend store/hook for contact presence:

- initial load calls `GET /v1/cloud/presence/contacts`,
- realtime websocket events update account statuses,
- polling fallback refreshes the read API if websocket is unavailable,
- store is keyed by account ID.

For local tunnel previews, use existing websocket gating behavior. If websockets are disabled, polling still keeps the UI current.

## UI design

Show presence as an avatar light only.

### Contacts

In the Contacts page cloud rows:

- Add a small presence light anchored to the contact avatar.
- Green means account rollup online.
- Muted gray means account rollup offline/unknown.
- Do not add status text, status pill, or last-seen copy.

### Participants

In group participant surfaces and compact participant/avatar strips:

- Add the same small avatar light.
- Use the same online/offline colors.
- Avoid changing participant row labels or adding status text.

### Accessibility

Because color alone is not enough, the avatar light should expose an accessible label/title such as:

- `111 is online`
- `222 is offline`

The visual UI remains light-only; assistive text can be screen-reader/title-only.

## Testing plan

### Backend tests

Add e2e/unit coverage for:

- online write marks the session device online.
- heartbeat keeps account online without duplicate events when rollup does not change.
- explicit offline marks the device offline and emits account offline when no other devices are online.
- one offline device does not mark account offline while another device remains online.
- timeout sweeper marks stale devices offline and emits rollup change.
- `GET /v1/cloud/presence/contacts` returns self + accepted contacts only.
- websocket/event delivery reaches accepted contacts only.

### Desktop tests

Add coverage for:

- sign-in/session activation publishes online.
- active session schedules heartbeat.
- logout/pagehide publishes offline.
- React effect remount cleanup does not publish offline.
- read API response populates the presence store.
- realtime presence event updates the store.
- Contacts avatar renders green/gray light without status text.
- Participant avatar renders green/gray light without status text.

## Rollout and validation

Manual preview validation should use Cloud Edition local tunnel preview with three instances:

- user1: `http://127.0.0.1:1482`
- user2: `http://127.0.0.1:1484`
- user3: `http://127.0.0.1:1486`

Validation flow:

1. Register/sign in all three users.
2. Add/accept contacts.
3. Confirm contact and participant avatars show green lights for online users.
4. Close one desktop instance.
5. Confirm that user's light becomes gray after explicit offline or timeout.
6. Reopen/sign in that user.
7. Confirm the light becomes green again.

## Open implementation notes

- Presence state should be independent from future agent execution capability state.
- Later #479 work can consume account/device presence to decide when owner-local execution is unavailable.
- Do not expose internal terms such as Bridge or host in UI copy.

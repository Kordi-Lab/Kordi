# Chat sync error registry

| Code | Status | Client behavior |
|---|---:|---|
| `INVALID_REQUEST` | 400 | Permanent failure; show actionable validation text. |
| `INVALID_MESSAGE_CONTENT` | 400 | Permanent failure; do not retry unchanged content. |
| `INVALID_SYNC_CURSOR` | 400 | Stop live processing and bootstrap. |
| `CHAT_FORBIDDEN` | 403 | Permanent failure unless membership changes. |
| `REALTIME_ORIGIN_NOT_ALLOWED` | 403 | Do not connect from this browser origin; correct the server allowlist. |
| `CHAT_ENTITY_NOT_FOUND` | 404 | Remove inaccessible cached state after sync confirms it. |
| `IDEMPOTENCY_KEY_REUSED` | 409 | Permanent programming error; never replace the original result. |
| `VERSION_CONFLICT` | 409 | Replace local state with the included current snapshot and let the user retry. |
| `SYNC_CURSOR_EXPIRED` | 409 | Discard incremental state as required and run bootstrap. |
| `MESSAGE_TOO_LARGE` | 413 | Permanent failure until content is reduced. |
| `CHAT_SYNC_CURSOR_UNAVAILABLE` | 503 | Retry later; do not fall forward to an unsigned cursor. |
| `INVALID_REALTIME_TICKET` | 400/401 | Request a new one-time ticket; never reuse the old ticket. |
| `SERVER_ERROR` | 500 | Retry the same client operation ID with backoff. |
| `CHAT_SYNC_INVARIANT_VIOLATION` | 500 | Stop applying events, report telemetry, and bootstrap. |

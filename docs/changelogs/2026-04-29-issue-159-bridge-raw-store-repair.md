# Issue #159 — Bridge raw-store repair

- Added an idempotent Bridge conversation-store repair pass for historical shared `bridge-person` session-relay agent responses that were stored in sibling base conversations.
- The repair moves split response rows into the scoped `:person` conversation, updates message outreach `bridgeConversationId`, and normalizes directions to `inbound-response` / `outbound-response`.
- Existing target response placeholders are merged by request/direction so historical final responses do not duplicate `processing...` rows.
- The repair is gated by a SQLite schema-meta key and runs during Bridge conversation migration/load after message outreach reconciliation.

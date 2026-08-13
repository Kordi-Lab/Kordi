# Issue #146 Bridge unread badges and read receipts changelog

PR: #156  
Issue: #146  
Branch: `feature/issue-146-unread-read-receipts`  
Base: `origin/main` at `6dd1917`

## Timeline

### 2026-04-29 16:25 +03:00 — Design and implementation plan

- `00be253` — Added the design spec for WhatsApp-style unread badges and reliable Bridge read receipts.
- `f736070` — Added the implementation plan covering unread hydration, read receipt transport, delivery visuals, tests, and manual QA.

### 2026-04-29 16:25 +03:00 — Core unread and read receipt plumbing

- `36ea395` — Preserved source unread counts during canonical session hydration instead of clobbering them to zero.
- `c8a8544` — Added Bridge read receipt helpers for active conversation matching, inbound request ID collection, and read signatures.
- `d6bc012` — Marked Bridge conversations read by inbound request IDs so receipts are not skipped when local unread state has already changed.
- `7d12487` — Rendered WhatsApp-style outbound delivery indicators: sent, delivered, read/responded.
- `25137a3` — Collected Bridge read receipt request IDs from inbound messages.
- `e5d83e9` — Sent Bridge read receipts with realtime first and relay fallback.
- `99397c1` — Tightened typing for canonical unread hydration.
- `bdb6bd8` — Formatted the Bridge read receipt implementation.

### 2026-04-29 16:25 +03:00 — Preview QA fixes

- `7d062c5` — Fixed Bridge unread badges and delivered acknowledgements for receiver-side realtime direct messages.
- `12c505b` — Hydrated unread counts for hidden Bridge outreach sessions routed through parent sessions.
- `5a1511b` — Scoped Bridge unread badges to the correct parent session so same-person sessions remain separate.

### 2026-04-29 16:26 +03:00 — Rebase cleanup

- `6722721` — Formatted desktop chat code after rebasing onto updated `main`.

### 2026-04-29 16:45 +03:00 — Mention and focus read clearing fixes

- `fe85d85` — Fixed full Bridge mention pill labels with spaces/punctuation and made read clearing respond to `focus`, `pageshow`, and `visibilitychange`.

### 2026-04-29 16:52 +03:00 — Multi-conversation parent session read clearing

- `7cfd23e` — Cleared unread for every Bridge conversation attached to the active session instead of only the first match.

### 2026-04-29 17:00 +03:00 — UUID parent session read clearing

- `4f75930` — Marked hidden Bridge conversations read when the active visible parent session is a normal UUID session rather than a `bridge:` or `session:bridge:` ID.

### 2026-04-29 17:05 +03:00 — Direct message display text fix

- `e82867d` — Kept implicit direct person session messages rendering exactly as typed instead of auto-prefixing the sender view with an `@target` mention pill.

## Validation timeline

- Ran `pnpm --dir app/desktop test:unit` — 59 tests passed.
- Ran `pnpm --dir app/desktop typecheck` — passed.
- Ran `pnpm --dir app/desktop lint` — passed.
- Ran `pnpm --dir app/desktop build` — passed.
- Ran `cargo fmt --all -- --check` — passed.
- Ran `cargo test -p kordi-desktop --no-default-features` — 64 tests passed.
- Ran `git diff --check` — passed.

## Manual QA timeline

- Previewed in existing isolated `user1` / `user2` desktop instances with preserved settings and data.
- Verified fresh messages in both directions.
- Verified unread badges appear on the correct parent session.
- Verified unread clears immediately when the receiver opens or focuses the relevant session.
- Verified sender-side delivery status progresses through sent, delivered, and read.
- Verified full mention labels such as `@Ethan's Kordi` render as one pill when the message is an explicit mention.
- Verified implicit direct person-session messages render as typed without auto-added mention text.

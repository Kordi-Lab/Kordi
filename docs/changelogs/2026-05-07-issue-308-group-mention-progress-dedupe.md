# Issue #308 — Dedupe group @mention progress cards

- Suppress raw Bridge processing placeholders when an in-flight local delegation already represents the same group @mention request.
- Match pending delegations by parent/request message id in addition to Bridge request id, covering Bridge placeholders that do not carry `requestId`.
- Added read-model regression coverage for the owner view where `My Kordi` and the public Bridge agent identity both report `Processing...` for the same request.

# 2026-05-11 — Issue #346 Cloud group session rename propagation

- Routed group child-session title renames to Cloud participants through Cloud group control messages instead of only Bridge outreach.
- Added a `group-session-title-update` Cloud group control envelope so peers can rename the exact child session while preserving the shared group space id.
- Kept non-cloud Bridge participants on the existing session-title-update outreach path.
- Added focused helper and Cloud envelope tests covering mixed Cloud/Bridge recipient routing and child-session title metadata.

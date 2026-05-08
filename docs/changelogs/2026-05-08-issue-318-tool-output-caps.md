# 2026-05-08 — Issue #318 tool output caps

- Added a central 50 KiB text cap for tool results before they leave the tool scheduler and again immediately before CLI persistence/events, so oversized tool payloads cannot be stored in sessions or sent back to providers unbounded.
- Preserved the head and tail of oversized tool output and annotate result details with `outputTruncated`, `originalOutputBytes`, and `maxOutputBytes`.
- Hardened `grep` by skipping generated/noisy directories by default (`.multi-instance-logs`, `.multi-instance-data`, `target`, `node_modules`, `.git`), limiting line width/file size for ripgrep, and reading search subprocess output through a capped stream buffer instead of unbounded `output()` collection.
- Added regressions for central scheduler truncation, capped grep stream reads, and excluding generated logs/build outputs from grep results.

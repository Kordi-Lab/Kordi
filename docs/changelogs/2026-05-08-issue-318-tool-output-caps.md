# 2026-05-08 — Issue #318 tool output caps

- Added a central 50 KiB text cap for tool results before they leave the tool scheduler and again immediately before CLI persistence/events, so oversized tool payloads cannot be stored in sessions or sent back to providers unbounded.
- Preserved the head and tail of oversized tool output and annotate result details with `outputTruncated`, `originalOutputBytes`, and `maxOutputBytes`.
- Hardened `grep` by skipping generated/noisy directories by default (`.multi-instance-logs`, `.multi-instance-data`, `target`, `node_modules`, `.git`), limiting line width/file size for ripgrep, and reading search subprocess output through a capped stream buffer instead of unbounded `output()` collection.
- Added the #253 RTK optimization layer for `bash`: opt-in via `KORDI_BASH_RTK=1`/`KORDI_RTK_ENABLED=1`, RTK availability/version detection, raw fallback, `raw: true` bypass, and `outputOptimization` result details.
- Added RTK documentation in `docs/rtk-output-optimization.md`.
- Removed noisy workflow-policy warnings from normal tool details so task creation/research chains do not report false advisory problems.
- Only advertise reflection lesson artifacts when the backing files exist, preventing agents from reading missing lesson files.
- Persist user-visible `task_operator` create/search/close actions into a durable local task table so later model turns can query real task state instead of relying on prior tool text.
- Added regressions for central scheduler truncation, capped grep stream reads, excluding generated logs/build outputs from grep results, RTK installed/uninstalled/opt-in/off behavior, fallback, raw bypass, missing reflection artifacts, and durable task persistence.

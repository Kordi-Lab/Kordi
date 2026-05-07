# Issue #209 — Composer plain path paste behavior

- Stopped auto-staging plain `text/plain` local paths as attachments so typed or pasted filesystem paths remain normal message text.
- Kept explicit OS file-copy paste support by accepting only `text/uri-list` `file://...` entries for path-based attachments.
- Allowed explicit directory path attachments to stage as folder attachments with `Folder` metadata while preserving the source folder path.

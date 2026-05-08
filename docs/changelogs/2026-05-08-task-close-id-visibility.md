# 2026-05-08 — Task close id visibility

- Include durable task IDs, titles, statuses, and summaries in `task_operator` runtime result text so models can read the ID from search/create results instead of relying on hidden structured details.
- Let durable `task_operator` close resolve a unique open task by `taskTitle` or `query` when `taskId` is unavailable, while still requiring an explicit ID for ambiguous matches.
- Merge task dashboard rows by both task ID and title aliases so title-only close events update the original task row instead of creating a duplicate row.
- Ignore failed durable close events when deriving lifecycle close status so a failed close attempt does not make an open task look closed.

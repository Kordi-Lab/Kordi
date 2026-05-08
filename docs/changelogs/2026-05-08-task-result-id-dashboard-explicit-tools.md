# Task result IDs and explicit dashboard rows

- Prefer the durable task ID reported by `task_operator` result text when syncing visible task events into the local task ledger, so follow-up agents can find the real opaque task ID instead of a model-supplied alias.
- Keep the task dashboard from creating task rows for ordinary live questions, including failed non-task tools, unless task-specific tooling or artifact output is present.

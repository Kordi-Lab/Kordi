# 2026-05-08 — Session-scoped task ledger

- Scope durable task_operator records by session so closing/searching tasks in one chat cannot pick an unrelated task from another chat.
- Store parent task IDs and arbitrary statuses for durable tasks, enabling lightweight subtasks in the same task table.
- Generate opaque `task_<uuid>` IDs for new local durable tasks instead of relying on natural-language IDs supplied by the model.
- Let `task_operator` search with no query list the current session's tasks so models can inspect the full task list before closing.
- Sync visible canonical task_operator events from shared sessions into the local session task ledger before @Kordi replies, and include current session task IDs in the local-agent prompt context.

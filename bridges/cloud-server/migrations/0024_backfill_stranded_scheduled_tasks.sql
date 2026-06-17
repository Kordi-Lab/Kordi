-- Repair scheduled tasks that were created active/enabled with no due time before
-- creation-time one-shot schedules were clamped to server now. Do not touch
-- completed one-shot tasks: those already have run history and intentionally
-- end with next_run_at = NULL.
UPDATE scheduled_tool_tasks task
   SET next_run_at = COALESCE(NULLIF(task.created_at, ''), task.updated_at)
 WHERE task.enabled = TRUE
   AND task.status = 'active'
   AND task.next_run_at IS NULL
   AND NOT EXISTS (
       SELECT 1
         FROM scheduled_tool_task_runs run
        WHERE run.task_id = task.task_id
   );

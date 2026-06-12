# Scheduled Task Run History UI Design

## Goal
Make scheduled Cloud tasks auditable in the Tasks panel and let users jump from a run output preview to the exact response message in the originating session.

## Approved UX
Use the existing unified Tasks panel. Scheduled task rows remain compact by default. Clicking a scheduled task expands it inline.

The expanded row shows:
- latest run status data: queued/running/completed/failed, timestamps, duration, and whether the response was posted;
- output history for recurring tasks, including daily/weekly jobs that produce multiple responses over time;
- each completed output row shows the first few words of the response message;
- clicking the output preview jumps to the exact response message in the same chat session;
- no separate `Reply` button.

## Data Model
The Desktop client needs scheduled run history in addition to the existing scheduled task list. The backend should expose a user-authenticated route for runs per task. Each run already has enough core fields:
- `runId`
- `taskId`
- `status`
- `targetRuntime`
- `dueAt`
- `resultMessage`
- `errorCode`
- `errorMessage`
- `createdAt`
- `updatedAt`
- `completedAt`

The Desktop can enrich completed runs by matching `resultMessage` to the current chat messages and extracting the visible assistant text preview.

## Interaction
Clicking the task row expands/collapses the task. Clicking a completed output preview calls the existing transcript navigation path with the matching local message id. Failed runs show the error summary and are only navigable if a failure response message exists.

## Scope
First pass supports latest run history inline. No retry controls, deletion controls, separate scheduled-task detail page, or full log drawer.

## Testing
Add tests for:
- backend route registration and run listing behavior;
- scheduled task client run-list parsing;
- Tasks panel rendering running status and output previews;
- clicking an output preview calls message navigation.

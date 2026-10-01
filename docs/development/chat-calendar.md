# Reading the Kordi calendar in chat

Ordinary desktop and cloud fallback chat expose the read-only `read_calendar` tool. It reads saved Kordi calendar events through the authenticated calendar store, preserving source visibility checks. It does not read external calendar services directly and does not promote chat arrangements or digest proposals into saved events.

The tool accepts optional `startAt` and `endAt` RFC3339 bounds and an `offset`. Results contain at most 50 event summaries, an account timezone when configured, and `hasMore` / `nextOffset` for pagination. Timed events overlap the requested interval; all-day events retain calendar-date semantics. `status: empty` means no saved events match the window, whereas `status: ready` with an empty page means the offset is beyond the matching events. Retrieval failures never mean the calendar is empty.

The host binds the account and conversation; model arguments cannot choose them. Desktop reads use the signed-in account and authenticated turn identity. Cloud reads use a live runner lease and the admitted run owner/requester. Requests addressed to another person's Agent cannot read that person's private calendar. Cloud execution subsessions cannot use this capability.

A shared conversation additionally requires `shareInConversation: true`. The tool instructions permit this only when the owner explicitly asks to inspect or share their own calendar in that conversation. The server requires a current, visible, owner-authored human request and active membership. Mentions, agent handoffs, and another participant's requests do not grant access. Without disclosure permission, the Agent should direct the owner to a private chat. Responses omit source IDs, descriptions, links, and reminder metadata, and the Agent must summarize only the requested dates and details.

## Owner approval in shared conversations

Reading the calendar for sharing in a group or direct conversation also needs the owner's approval in Kordi. The server never returns calendar data for such a read until the owner allows it:

- The first read creates a `calendar_disclosure` pending action for the owner and answers `200 {"status":"approval_required","pendingActionId":…,"message":…,"timeoutMessage":…}`. Repeated reads of the same request and window reuse it. A waiting request expires after 10 minutes.
- Approving grants this owner, conversation, and exact window (`startAt` and `endAt` as given) for 10 minutes. Paging, and new requests for the same window within the grant, read directly.
- Declining answers `200 {"status":"declined","message":…}` for that request only. The next request asks again.
- Private reads (no conversation) never wait.

The owner sees and decides the request through `GET /v1/cloud/agent-actions` and `POST /v1/cloud/agent-actions/:action_id/decision` (`{"decision":"approve"|"decline"}`). Only the owner sees a calendar request; anyone else gets `404 agent_action_not_found`, a closed or expired request answers `409 agent_action_closed`, and repeating the same decision returns the current action. Every change sends `agent_action.updated {agentAction}` to the owner's sync stream; older apps ignore it. Owners on older apps cannot approve, so the agent tells them to update or ask in a private chat.

Both runtimes wait for the decision inside the tool call: the read repeats every 3 seconds for at most 120 seconds and stops when the run or turn is cancelled. The model receives calendar data, the owner's decline, or the timeout text, never a half-finished wait. The cloud runner's heartbeat keeps the run's lease while it waits (`bridges/cloud-agent-runner/src/model_loop/calendar_wait.rs`); the desktop tool loops inside `agent/crates/tools/src/calendar.rs::http_runtime`. Older tools hand the waiting or declined answer to the model as text, so nothing is disclosed.

## Other tools after sharing

Once a run or turn received a calendar data page read for sharing (`scope: owner_requested_shared_read` with status `ready` or `empty`), only `read_session`, `search_sessions`, and `read_calendar` may run for the rest of that run or turn. Every other tool, including `task_operator`, scheduling, local apps, commands, web tools, `reach_out`, and MCP and extension tools, returns "Other tools are off for the rest of this request because it read the owner's calendar. Answer with what you already have." The cloud runner checks this at the top of `execute_model_tool`; the desktop and agent runtime check it in `kordi_tools::ensure_tool_allowed`, the single gate for built-in, MCP, and extension tools, through `CalendarRuntime::disclosed`, which is rebuilt for every turn.

## Code and tests

Desktop calls `POST /v1/cloud/calendar/read`; cloud fallback dispatches through the run-authorized context endpoint. Both use the same calendar reader and the same approval gate (`bridges/cloud-server/src/cloud_agent_runtime/agent_actions/calendar.rs`). Regression coverage lives in the tools calendar and scheduler tests, desktop calendar runtime tests, cloud model-loop tests, the calendar HTTP integration tests, and `bridges/cloud-server/tests/agent_actions_e2e.rs`. The HTTP tests require a fresh isolated PostgreSQL database containing synthetic fixtures only.

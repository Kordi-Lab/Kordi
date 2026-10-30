# Agent communication with Mac-first execution

`reach_out` sends an explicit question to an agent in the same conversation.
It returns a delivery receipt, not a fabricated answer. The first turn ends;
the recipient's answer queues a continuation of the original agent's task.
The public question and recipient reply are canonical chat messages. A
continuation publishes only new useful work requested by the user, not a
confirmation, quotation, or paraphrase of the reply already in this conversation.

The parent yields with the internal `{"agentExchangeOutcome":"waiting"}`
completion. Both publishers normalize delegated parents to this result; the
read model retires progress without rendering a redundant finished bubble.
On resumption, `{"agentExchangeOutcome":"silent"}` acknowledges that no
additional work is needed. The server accepts it only for a continuation with
a public reply, atomically completes the run and exchange, and creates no
message. An empty answer, failed provider, silent recipient, or timeout without
a public reply is not a successful silent completion. Retries retain the same
lease checks and idempotency as a visible result.

The continuation's original request comes from the canonical triggering
message, including after further delegation. An executor prompt may contain
conversation history; that history must not become a list of unfinished tasks.

The server owns a durable exchange record, not the model execution location.
Each recipient and continuation is an ordinary run: a ready owner Mac gets
its existing preference window and execution lease. Eligible cloud fallback
uses that same run after the window expires. Existing project-device rules
still apply. No laptop-to-laptop bridge or inbound Mac listener is needed.

## Delivery and recovery

- Sending the same tool call again returns the same receipt. A replayed call
  with the same parent, target, and question also returns that receipt.
- A reply is stored separately from acknowledgement that its continuation
  finished. Human read receipts never advance agent processing state.
- Desktop discovery and cloud leasing reconcile durable records. Restarting
  either process does not require a process-local callback to find the reply.
- An expired desktop claim can be rediscovered. New local request IDs include
  the claim, and stale executors cannot publish through the new lease.
- Duplicate completion is idempotent. A single exchange can create only one
  recipient run and one continuation run. Model/tool execution is at least
  once after a crash; external side effects still need their own idempotency.
- An unavailable recipient or a ten-minute deadline produces an explicit
  failure result for the original agent. It is never presented as a reply
  from the recipient. Cancelling the root prevents its continuation.

The design borrows SwarmChat's separation of durable message delivery from
independent agent execution and its recovery through rereading pending work.
Kordi uses its existing PostgreSQL transactions, canonical chat, and fenced
leases, rather than adopting a second message server or chat read cursor.

## Authorization

Only a live execution lease for an owner's own request can send outreach.
Targets must be active agents belonging to current conversation members;
custom agents must allow participant conversations. Handles must be unique,
or the caller must supply the exact agent ID. Both execution and publication
revalidate membership and the original source request. A removed member or
deleted source cancels pending work. Replies are untrusted conversation data,
not permission to access private resources. No project files, hidden history,
or credentials are automatically attached. Shared recipient turns cannot
redelegate. A root task has a bounded budget of eight exchanges.

The desktop checks server capability before advertising `reach_out`. Both
local engines hide it without an attached runtime. Cloud leases explicitly
advertise support, so older servers do not create a false tool promise.

## Validation

Database regression tests use three disposable synthetic accounts and cover
request deduplication, Mac priority, expired-lease recovery, stale completion,
reply/continuation idempotency, direct chat, revoked membership, and timeout.
Frontend tests cover concurrent discovery, rediscovery after a failed claim,
lease loss, stored routing, and retrying a lost completion acknowledgement.
Regression tests also cover silent completion on Mac and cloud, stale claims,
completion retries, missing replies, hidden progress, and useful follow-up output.
Real test-client validation must additionally check visible messages and the
continued response. It must preserve the existing profiles and account data.

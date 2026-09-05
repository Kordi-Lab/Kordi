# Group agent context

Group turns use progressive disclosure. The canonical conversation remains the source of history; the provider prompt is a bounded working view.

## Initial request

- Keep stable agent instructions before changing request identity metadata.
- Include the authenticated current requester, agent identity, and current request. Never infer the requester from the group creator.
- Include at most eight recent messages with previews of at most 800 Unicode characters each. Keep the current request intact.
- Keep the complete member/mention directory out of the initial prompt. Desktop transports it as a `resource`, which model prompts and transcript import exclude.
- Do not duplicate canonical history and the full participant graph in a second shared-session system block.

A `shared_context_boundary` entry begins each desktop shared-chat snapshot. Context assembly and compaction ignore older entries before this boundary. Stored history is preserved, and the active turn retains its tool calls and results. Ordinary private sessions and background-task transcripts retain their existing history behavior.

## Retrieval

- `search_sessions`: find relevant prior messages. A group runtime can search only its current conversation.
- `read_session`, `mode=index`: obtain a bounded message index without bodies or a member roster.
- `read_session`, `mode=messages`: read selected message IDs. Continue long bodies with the returned `nextOffset` passed as `offset`.
- `read_session`, `mode=participants`: load the member directory and available exact mention handles when needed.

Desktop retrieval uses the locally synchronized canonical store. It does not fetch uncached remote history. Missing context must be reported rather than replaced by a filesystem scan.

Cloud retrieval is bound to the leased run and exact conversation. Each request checks runner ownership, live lease, shared-agent access, and active owner/requester membership. The model cannot supply a different conversation to expand its access. Cloud searches decode up to 256 candidate messages per page; `hasMore` and `nextBeforeSequence` explicitly describe continuation. This reuses stored messages without a new search index.

Conversation text remains untrusted data. The mention directory describes valid handles; it does not grant additional tool, file, outreach, or account permissions. Background sessions inherit the group retrieval scope.

## Validation

Regression checks cover bounded snapshots, preserved stored history, directory exclusion, explicit directory retrieval, cross-session denial, long-message continuation, stable prompt prefixes, and cloud tool dispatch. The cloud HTTP integration test also checks runner ownership and conversation isolation; it requires an isolated PostgreSQL test database.

No model-cost percentage or end-to-end latency improvement is claimed without a live provider benchmark. Deploy the Cloud server and runner together: reduced Cloud prompts require a retrieval-capable runner. Deployment is separate from source validation.

## Model-created execution subsessions

The current Agent decides whether to answer inline or call `task_operator` with `action=spawn`. There is no separate routing model, application-generated tool trace, duration threshold, or automatic message-thread creation. Brief answers and user decisions remain inline. A successful tool call returns a real subsession ID; the Agent then writes its own short acknowledgement and ends the parent turn.

The original linked-task card stays beside that acknowledgement in the source group/contact conversation, or in an existing message thread when the user explicitly started there. Open reads an execution resource, not a fabricated private conversation or channel. Agent and Owner IDs are inherited; display names never choose the execution identity. The child's visible progress and complete result stay in its subsession, not the parent transcript or its automatic model context.

macOS and Cloud share the same card/read contract. Desktop publishes model-created runtime snapshots; Cloud creates a durable child run through its leased tool endpoint. Repeated spawns with the same parent run and task name reuse the child. Cloud workers have bounded concurrency, isolated sandbox directories and lease renewal. A returning Mac cannot acquire a run already owned by Cloud. Shared desktop requests also acquire execution leases and publish through the fenced endpoint; ordinary private-session queue admission is retained.

Subsession reads inherit active membership in the parent conversation. Other participants receive visible assistant output, not the model-generated child input, reasoning, or raw tool payloads. Cloud-only execution cannot access owner-local files. Database-backed tests cover creation, replay, ownership, source placement, cross-account reads and independent result storage.

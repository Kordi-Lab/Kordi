# Group agent context

Group turns use progressive disclosure. The canonical conversation remains the source of history; the provider prompt is a bounded working view.

## Initial request

- Keep stable agent instructions before changing request identity metadata.
- Include the authenticated current requester, agent identity, and current request. Never infer the requester from the group creator.
- Include at most eight recent messages with previews of at most 800 Unicode characters each. Keep the current request intact.
- Keep the complete member/mention directory out of the initial prompt. Desktop transports it as a `resource`, which classifiers, child-task prompts, and transcript import exclude.
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

## Generated start messages

Following PR #1250, the routing model generates the task title, summary, parent acknowledgement, and self-contained child request in its existing routing call. A background decision without all four fields is invalid and falls back to the normal inline agent turn; no canned acknowledgement is substituted. The acknowledgement is published only after child-session creation succeeds.

The router starts with the current request and source session/message IDs. It can use the same group-scoped search/read tools to resolve ambiguity. Child requests contain the generated task and source references, without copied group history, member directories, or duplicate agent-definition text. Execution policy stays in the child system prompt.

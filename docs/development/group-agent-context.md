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

The original linked-task card stays beside that acknowledgement in the source group/contact conversation, or in an existing message thread when the user explicitly started there. On macOS, Open uses the existing Companion pane beside the source conversation; it never opens a separate modal or replaces the main chat. On iOS, Open pushes the existing conversation view as a child chat. Both read the same execution resource, not a fabricated private conversation or channel. Agent and Owner IDs are inherited; display names never choose the execution identity. The child's visible progress and complete result stay in its subsession, not the parent transcript or its automatic model context.

Open presents the normal conversation UI, including the message composer. Active source-conversation members can exchange text in the subsession. Only a valid, explicit structured mention of its bound Agent ID creates a follow-up run. Plain participant messages are shared context, not execution requests. Busy follow-ups display `Queued next` without an assistant progress placeholder; an idle request waits for actual execution admission before showing activity. Follow-ups retain the same subsession, Agent, and Owner IDs and are serialized by the existing execution lease contract.

Desktop continuation resumes the existing native session and its saved runtime profile; it never falls back to an unrelated local chat or default tool permissions. Cloud takeover uses the subsession transcript and prior participant messages. Once Cloud owns a subsession, subsequent turns continue there rather than starting a second native copy. Access is inherited from the source conversation and is rechecked before execution. No follow-up transcript is published into the source conversation, and old message threads are not migrated.

macOS and Cloud share the same card/read contract. Desktop publishes model-created runtime snapshots; Cloud creates a durable child run through its leased tool endpoint. Repeated spawns with the same parent run and task name reuse the child. Cloud workers have bounded concurrency, isolated sandbox directories and lease renewal. A returning Mac cannot acquire a run already owned by Cloud. Shared desktop requests also acquire execution leases and publish through the fenced endpoint; ordinary private-session queue admission is retained.

Subsession reads inherit active membership in the parent conversation. Members receive the Agent-authored task brief and visible assistant output, never private system instructions, reasoning, or raw tool payloads. Human follow-ups retain their authenticated sender identity. Cloud-only execution cannot access owner-local files. Database-backed tests cover creation, replay, ownership, source placement, cross-account reads and independent result storage.

## Conversation boundaries

| Surface | Visibility and identity | Trigger |
| --- | --- | --- |
| Ask Agent | Owner-only Agent conversation | Owner sends a request |
| Agent execution subsession | Active members of its source conversation; one bound Agent and Owner ID | Agent calls the spawn tool; later replies require an explicit mention of that Agent |
| Message discussion thread | Same members as its parent conversation | A member chooses Reply in thread |
| Private Agent fork | Independent owner-only Agent session with inherited reference history | Owner forks an Agent session |

Names are current presentation data, not routing identifiers. A profile rename updates selectors, headers and mention choices by Agent ID without rewriting stored message text or changing the scope of an existing conversation.

## Request identity and caching

The server freezes the authenticated requester, Agent and Owner metadata once for each admitted run. Desktop and Cloud append it after existing history and before the new user request. Retries and tool iterations reuse the same metadata. Participant text cannot replace that binding or confer private access.

Desktop identity-bound runtimes retain their prepared system header across follow-ups. Historical identity records keep the labels that were valid for those turns; a new turn can carry renamed labels without rewriting the earlier prefix. Provider tools, model routing, cache keys and cache controls are unchanged. Prefix regression tests do not guarantee real-provider cache hits, which also depend on cache lifetime and routing.

## Upgrade and rollout

Non-owner desktop requests use a frozen per-turn execution policy, resolved from authenticated Agent/Owner/Requester IDs. Tool schemas and ordering do not change. Local reads, filesystem searches, commands, writes, outreach, scheduling, reflection and extension tools are denied before execution; extension hooks do not run for these turns. Inline `@file` expansion and local attachment paths are also disabled. Only audited public-web tools and callbacks scoped to the current shared conversation are available. Missing scope fails closed; background work inherits the identity and cannot request local write access or copy private history. Owner requests retain the configured local permissions.

Shared web transport validates literal addresses, every redirect and the DNS answers used by the connection, and does not inherit system proxies. Cloud uses the same public-web transport while its file/command tools remain confined to the existing conversation sandbox. Neither mode grants access to an owner's device or other private sessions.

Deploy the server and runner before updating desktop executors: new desktop execution requires a server-authored identity snapshot. No automatic production rollout is part of this change.

The stability branch and main used migration 76 for different work. Migration 82 adds the digest/calendar schema idempotently without changing an already-recorded migration or replaying historical conversation deletion. An upgrade regression starts from main's version 76 and verifies that existing chat, digest and calendar data survive.

Before deployment, audit legacy Direct session IDs. Migration 80 removes only the explicitly identified obsolete development seed namespace and fails closed if other noncanonical Direct identities remain. Do not delete unrecognized conversation data to bypass that check.

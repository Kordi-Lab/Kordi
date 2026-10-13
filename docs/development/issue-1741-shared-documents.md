# Issue 1741: Shared documents

Status: implementation contract, 2026-10-11. Tracks [#1741](https://github.com/Kordi-Lab/Kordi/issues/1741). The approved preview is in `docs/design-previews/shared-documents/`.

## Summary

Agent-written Markdown and HTML attachments open as documents on iPhone and Mac and can be shared with anyone through a public link that works without a Kordi account. Reactions and comments are anchored to document blocks and are shared by everyone who can see the document. The server owns block identity, rendering of the public page, and all access checks.

| PR | Scope |
|---|---|
| 1 | Server: `document_shares` module, migration 122, authenticated and public routes, public page, reactions, comments |
| 2 | Mac: document reader in the Artifacts panel, Share popover, upload for Mac-hosted documents, `kordi.ai/d/` link handling |
| 3 | iPhone: document reader, tabs, selection menu, share sheet, link handling |
| 4 | Deploy: forward `/d/*` on the product origin to the server; universal links later |

## Decisions

- **Open decision 1:** Mac-hosted documents upload on first share, not on every save. Until then the iPhone shows the card with an **On this Mac** badge and cannot open it.
- **Open decision 2:** public pages render Markdown server-side and HTML artifacts inside a sandboxed iframe served from a separate route with a strict `Content-Security-Policy`. No script from a shared file runs on the kordi.ai origin.
- **Open decision 3:** readers without an account can react and comment with a name only. Public writes are rate limited per IP and capped per share. The agent-mention reply for comments (issue comment of 2026-10-09) is recorded in the data model (`mentionsAgent`, `readersCanAskAgent`) and shipped as a follow-up once a run can be scoped to a document block.
- Reactions and comments are keyed by attachment, not by share, so revoking a link keeps what the session's people wrote and a new link shows the same thread.
- Document blocks are the top-level Markdown blocks in source order with ids `b0`, `b1`, … An HTML document is one block, `b0`. Clients never compute ids for a document the server has; the Mac computes the same ids for a local file only until it is uploaded.

## Data

Migration `0122_cloud_document_shares.sql`:

- `cloud_document_shares`: `share_id` (text PK, `docshare_` prefix), `token_hash` (SHA-256 hex, unique), `attachment_id` → `cloud_attachments`, `owner_account_id` → `cloud_accounts` (cascade), `session_id` (nullable text), `access_mode` (`link`), `readers_can_ask_agent` (bool, default true), `created_at`, `revoked_at` (RFC 3339 text like the invitation tables). Index on `(owner_account_id, attachment_id, created_at DESC)`.
- `cloud_document_reactions`: `reaction_id` PK, `attachment_id` (cascade), `block_id`, `reaction` (one emoji, max 16 chars), one of `actor_account_id` (cascade) or `actor_reader_key` plus `actor_name`, `created_at`, `deleted_at`. Partial unique indexes keep one live reaction per actor, block, and emoji.
- `cloud_document_comments`: `comment_id` PK (`doccmt_` prefix), `attachment_id` (cascade), `block_id`, `parent_comment_id` (self reference, cascade), `author_account_id` (nullable, cascade) or `author_reader_key`, `author_name`, `body` (1 to 4000 chars), `mentions_agent` (bool), `created_at`, `edited_at`, `deleted_at`, `resolved_at`.

Tokens follow the invitation shape: `kordi_ds_` plus 32 bytes in URL-safe base64 without padding (43 characters), stored only as a SHA-256 hex hash. So the owner can copy the link again, the 32 bytes are an HMAC-SHA256 of the random share id under a server secret, not a second random value: `KORDI_DOCUMENT_SHARE_SECRET` (at least 32 bytes), else `KORDI_CHAT_SYNC_CURSOR_SECRET`. Without either, creating, listing, and changing shares answer `503` with code `document_sharing_unavailable`; public lookups still work by hash. Changing the secret makes the links of existing shares unrecoverable for their owners: the stored hashes still open the old links, but the server can no longer rebuild them. Share URL `${KORDI_PUBLIC_APP_URL:-https://kordi.ai}/d/<token>`; deep link `kordi://document/<token>`.

## Authorization

- Reading a document and listing its reactions and comments through the authenticated route uses the attachment rule in `attachments/access.rs`: owner, or active member of a conversation that carries the attachment.
- Creating, listing, changing, and revoking shares requires the attachment owner (the account that uploaded it; agent artifacts are uploaded under the session owner).
- Editing or deleting a comment requires its author; resolving requires the attachment owner or the author.
- Public routes require a live, unrevoked share. A revoked or unknown token answers `404` with code `document_link_off` and the message "This link is off".

## Routes

Authenticated (bearer session; `Extension<Arc<CloudRateLimiter>>` applied):

| Method and path | Body | Response |
|---|---|---|
| `GET /v1/cloud/documents/:attachment_id` | | `DocumentResponse` |
| `GET /v1/cloud/documents/:attachment_id/raw` | | the HTML artifact bytes with the same `Content-Security-Policy` and `X-Frame-Options` as `/d/:token/raw`; `404` for Markdown documents |
| `POST /v1/cloud/documents/:attachment_id/shares` | `{ "sessionId"?: string, "readersCanAskAgent"?: bool }` | `DocumentShare`; returns the existing live share when one exists |
| `GET /v1/cloud/documents/:attachment_id/shares` | | `{ "shares": DocumentShare[] }` live shares owned by the caller |
| `PATCH /v1/cloud/documents/shares/:share_id` | `{ "readersCanAskAgent": bool }` | `DocumentShare` |
| `DELETE /v1/cloud/documents/shares/:share_id` | | `204` |
| `POST /v1/cloud/documents/:attachment_id/reactions` | `{ "blockId": string, "reaction": string }` | `{ "reactions": DocumentReaction[] }` for that block after the toggle |
| `POST /v1/cloud/documents/:attachment_id/comments` | `{ "blockId": string, "body": string, "parentCommentId"?: string }` | `DocumentComment` |
| `PATCH /v1/cloud/documents/comments/:comment_id` | `{ "body"?: string, "resolved"?: bool }` | `DocumentComment` |
| `DELETE /v1/cloud/documents/comments/:comment_id` | | `204` |

Public (no session; every request is charged to the client address, separately from the sign-in limit: reads (`GET /d/:token`, `GET /d/:token/raw`, `GET /v1/cloud/public/documents/:token`) against `DOCUMENT_PUBLIC_READ_LIMIT`, 120 per 60 seconds, and reaction and comment posts against `DOCUMENT_PUBLIC_WRITE_LIMIT`, 30 per 60 seconds; over a limit answers `429` `rate_limited` with `Retry-After`. Public writes are also capped at 500 live comments and 2000 live reactions on the document, answering `429` `document_limit_reached`):

| Method and path | Body | Response |
|---|---|---|
| `GET /d/:token` | | HTML page |
| `GET /d/:token/raw` | | the HTML artifact bytes with `Content-Security-Policy: sandbox; default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; font-src https: data:` and `X-Frame-Options: SAMEORIGIN`; `404` for Markdown documents |
| `GET /v1/cloud/public/documents/:token` | | `DocumentResponse` with `viewer: "public"` |
| `POST /v1/cloud/public/documents/:token/reactions` | `{ "blockId", "reaction", "readerKey", "readerName" }` | `{ "reactions": DocumentReaction[] }` |
| `POST /v1/cloud/public/documents/:token/comments` | `{ "blockId", "body", "readerKey", "readerName", "parentCommentId"? }` | `DocumentComment` |

`readerKey` is a client-generated opaque string (16 to 64 URL-safe characters) kept in the browser or app so a reader can toggle their own reactions. `readerName` is 1 to 40 characters after trimming.

## Shapes

All field names are camelCase.

```
DocumentResponse {
  attachmentId: string,
  title: string,                    // first level-1 heading, else <title>, else file name without extension
  fileName: string,
  format: "markdown" | "html",
  contentType: string,
  sizeBytes: number | null,
  createdAt: string,                // attachment finalized_at
  updatedAt: string,
  sessionId: string | null,
  sessionTitle: string | null,
  author: { accountId: string, displayName: string, kordiId: string, avatarUrl: string | null },
  agent: { displayName: string } | null,   // agent that produced the artifact when known
  blocks: [{ id: string, source: string, html: string }],   // html is sanitized; for format "html" blocks is [{ id: "b0", source: "", html: "" }] and rawPath is set
  rawPath: string | null,           // "/d/<token>/raw" for public HTML documents, "/v1/cloud/documents/<id>/raw" when authenticated
  reactions: DocumentReaction[],
  comments: DocumentComment[],      // unresolved and resolved, undeleted; sorted by createdAt
  share: DocumentShare | null,      // null for viewers who are not the owner, and on public routes
  viewer: "owner" | "member" | "public",
  viewerCan: { share: bool, react: bool, comment: bool, askAgent: bool }
}

DocumentShare { shareId, attachmentId, shareUrl, deepLink, accessMode: "link", readersCanAskAgent: bool, createdAt, revokedAt: string | null }

DocumentReaction { reactionId, blockId, reaction, actor: { accountId: string | null, readerKey: string | null, displayName: string }, mine: bool, createdAt }

DocumentComment { commentId, blockId, parentCommentId: string | null, author: { accountId: string | null, displayName: string, kordiId: string | null, avatarUrl: string | null }, body, mentionsAgent: bool, mine: bool, createdAt, editedAt: string | null, resolvedAt: string | null }
```

Public responses never include account ids other than the author's public profile fields (`displayName`, `kordiId`, `avatarUrl`), never include email addresses, and never include `readerKey` values other than the caller's own (`mine`).

On public routes `author.accountId` is an empty string, `actor.accountId` and comment `author.accountId` are `null`, comment `author.kordiId` is set only for the document author, and `sessionId` and `sessionTitle` are `null`. The public read `GET /v1/cloud/public/documents/:token` takes the caller's reader key as an optional `?readerKey=` query parameter or `X-Kordi-Reader-Key` header so `mine` is set on their reactions and comments.

## Rendering

Markdown renders with `pulldown-cmark` (tables, strikethrough, task lists, footnotes off). Raw HTML events in Markdown are dropped. Links get `rel="noopener noreferrer"` and only `http`, `https`, and `mailto` schemes survive. Images keep `https` and `data:image/*` sources only. The public page sets `Content-Security-Policy: default-src 'none'; style-src 'nonce-…'; script-src 'nonce-…'; img-src https: data:; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'` and `Referrer-Policy: no-referrer`.

The public page uses the system font stack, the title, a date pill, and the `@author` chip with a People card (avatar, name, Kordi ID, **Add on Kordi** linking to `https://kordi.ai/`), a Kordi bar with **Open in Kordi** (`kordi://document/<token>`), paragraph selection with comment and react only, reaction pills, inline comments with author and time, and a footer "Shared by <author>". No serif fonts, no all-caps headings, no explanatory copy.

## Clients

- **Mac:** the Artifacts panel opens `text/markdown` and `text/html` artifacts in the document reader. The header shows title, date pill, `@author` chip (People card with **Message**). Selecting a paragraph shows the floating menu (comment, react, Aa, bold, italic, underline, strikethrough, code, highlight, list, link). The Share popover has one switch **Anyone with the link**, the link row with **Copy** when on, the **Readers can ask the agent** switch, and rows **Send in Kordi**, **Share link**, **Show in Finder**. Turning the link off asks for confirmation. Documents from Mac-hosted sessions show **On this Mac**; Share first offers **Upload to Kordi** through the existing attachment initiate, upload, finalize path, after which the badge becomes **In Kordi**. `kordi://document/<token>` and `https://kordi.ai/d/<token>` open the reader through the public JSON route and offer **Open in session** when the viewer is a member.
- **iPhone:** the attachment card and the session detail Files tab open the reader for `text/markdown` (native Markdown parser) and `text/html` (`WKWebView`, scripts off, no network). Tab bar with `Tab 1` dropdown (**Show on page**, tab list, **New tab**) and insert tools. Share sheet in the flat Settings-sheet style. **Send in Kordi** reuses the forward flow. `kordi://document/<token>` opens the reader; `https://kordi.ai/d/` links are parsed the same way. Universal links wait for the `apple-app-site-association` file.

## Deploy

The server only answers under `/v1/cloud/*`, `/i/*`, and `/g/*` today. The product reverse proxy needs `/d/*` forwarded to the server. This is a product-server change and runs only with explicit authorization on the product machine.

## Editing (added 2026-10-11 after live testing)

Cloud documents are editable by the owner and by active members, with document-level synchronization: a save carries the whole Markdown source and the revision it was based on; the server rejects stale saves and tells every member to reload.

### Data

Migration `0123_cloud_document_contents.sql`: `cloud_document_contents` with `attachment_id` (PK, cascade), `source` (text), `revision` (bigint, starts at 1), `updated_by_account_id`, `updated_at`. The first read of a Markdown document copies the attachment bytes into this table at revision 1; from then on the stored source is canonical for the authenticated routes, the public page, and the public JSON. HTML documents are not editable in this round (`viewerCan.edit` is false for them).

### Routes

| Method and path | Body | Response |
|---|---|---|
| `PUT /v1/cloud/documents/:attachment_id/content` | `{ "baseRevision": number, "source": string }` | `DocumentResponse` with the new `revision`; `409 document_revision_conflict` with the current `DocumentResponse` in the body when `baseRevision` is behind; `403 document_edit_forbidden` for viewers without `viewerCan.edit`; `413` above 1 MiB |

`DocumentResponse` gains `revision: number` and `viewerCan.edit: bool`. Public responses carry the revision too.

On every accepted save the server publishes the user sync event `document.updated` with payload `{ "attachmentId", "revision", "sessionId", "updatedByAccountId" }` to the owner and the active members of every conversation that carries the attachment. Clients that show the document refetch it on that event; a client with unsaved local changes rebases them onto the new revision (block by block; a block edited on both sides keeps the remote text and shows "Updated elsewhere" once).

### Block identity across edits

Blocks keep index ids (`b0..bn`). In the same transaction as a save the server remaps reactions and comments: a block whose trimmed source still exists in the new document keeps its annotations at the new index (first unmatched occurrence in order); annotations on a block that disappeared move to the nearest preceding block that survived, or to `b0`.

### Inline formats

The selection menu applies Markdown to the selected text inside one block: `**bold**`, `*italic*`, `<u>underline</u>`, `~~strikethrough~~`, `` `code` ``, `==highlight==`, list (prefix every line of the block with `- `, or remove it), link (`[text](https://…)` after asking for the URL), and Aa (block style: paragraph, heading 1 to 3, quote). Renderers accept `<u>` and `<mark>` as the only inline HTML and render `==text==` as `<mark>`. Comment and react anchor to the block that contains the selection.

## Forwarded copies and live annotations (added 2026-10-12 after live testing)

Forwarding a message re-uploads its attachments under the sender's account (the chat store only links attachments the sender owns), so a forwarded document got its own reactions, comments, revision, and link. Documents are identified by their canonical attachment instead:

- Migration `0124_cloud_document_sources.sql` adds `cloud_attachments.document_source_attachment_id` (nullable, references `cloud_attachments`, set null on delete) with an index. The canonical attachment of a document is the end of that chain (one hop in practice).
- `POST /v1/cloud/documents/:attachment_id/source` with `{ "sourceAttachmentId": string }`: the caller must own `:attachment_id`, must be able to read `sourceAttachmentId` under the attachment access rule, both must be finalized Markdown or HTML documents of the same format, and `:attachment_id` must have no content row, reactions, comments, or shares of its own yet. Answers the canonical `DocumentResponse`. Clients call it right after uploading a forwarded document attachment and before sending the message; the message still carries the copy's id.
- Every document route (`GET /v1/cloud/documents/:id`, `/raw`, `/content`, `/shares`, `/reactions`, `/comments`, and the artifact lookups behind them) resolves `:id` to the canonical attachment first and operates there. `DocumentResponse.attachmentId` is the canonical id; it also carries `requestedAttachmentId` when the two differ. Access is checked on the requested id (the caller can read the copy they were sent), then everything is read from and written to the canonical document.
- The audience of `document.updated` is the owner plus the active members of every conversation carrying the canonical attachment or any copy that points at it.
- Reactions and comments publish `document.updated` too, with `"change": "annotations"` and the current `revision`; saves publish `"change": "content"`. Clients that show the document refetch on both; a client with unsaved edits merges as before.
- Clients: the Mac and iPhone forward flows call the source route for Markdown and HTML attachments after the upload. Readers key their state by the canonical `attachmentId` from the response.

## Stable block ids (added 2026-10-12, editor proposal phase 1)

The Mac editor stamps every top-level block with an id and serializes it as a trailing HTML comment on the block's last line: `<!-- k:7f3a9c2d -->` (`k:` plus 4 to 32 characters of `[A-Za-z0-9_-]`). Rules:

- `DocumentBlock.id` is the comment's value when the block carries one (`k:7f3a9c2d`), else `b{index}` as before. `DocumentBlock.source` never contains the comment; the server strips it before rendering and before returning the source, and re-attaches nothing. The stored document source keeps the comments.
- Migration `0125_cloud_document_block_ids.sql` relaxes the `block_id` checks on `cloud_document_reactions` and `cloud_document_comments` to `^(b[0-9]{1,5}|k:[A-Za-z0-9_-]{4,32})$`.
- On save, the index remap runs only for annotations whose block id is index-based; ids with the `k:` prefix follow their block wherever it moves, and annotations whose `k:` block no longer exists move to the nearest preceding surviving block by document order (or `b0` / the first block).
- When a document without ids is first saved by an editor that stamps ids, the save carries the mapping `{ "blockIds": { "b3": "k:…" } }` next to `source`, and the server rewrites the annotations' block ids in the same transaction.
- The public page and the JSON routes expose the resolved ids; clients never see the comments.

## Collaborative editing with Yjs (added 2026-10-12, editor proposal phase 2)

Keystroke-level co-editing follows Tiptap's collaboration setup: the Mac editor loads `@tiptap/extension-collaboration` (with `undoRedo: false` in StarterKit, since Collaboration brings its own history), `@tiptap/extension-collaboration-caret`, `yjs`, and the `y-websocket` provider. The server speaks the same wire protocol as `y-websocket` (y-protocols sync v1 plus awareness) using the `yrs` and `y-sync` crates, so no Node service is needed. Markdown stays the exchange format: snapshots feed the public page, the iPhone reader, search, and the agent.

### Rooms and transport

- One room per canonical attachment, held in memory by the server process and loaded on first join from `cloud_document_collab` (migration `0126_cloud_document_collab.sql`: `attachment_id` PK, `state` bytea, `state_vector` bytea, `seq` bigint, `initialized_at`, `updated_at`) plus `cloud_document_collab_updates` (`attachment_id`, `seq`, `update` bytea, `created_at`) appended after `seq`. Every client update is appended; the room compacts into `state` every 200 updates or 5 minutes and on the last disconnect, then deletes updates at or below the new `seq`. Single replica today; fan-out through NATS is a later step.
- `POST /v1/cloud/documents/:attachment_id/collab/ticket` (authenticated; owner or active member of a family conversation; HTML documents answer `409 document_not_collaborative`) issues a single-use, session-bound ticket with a 60 second lifetime and an allowed origin, like the chat realtime ticket, under a per-account budget `document-collab-ticket` of 60 per minute. Response `{ "ticket", "url" }` where `url` is the socket path `/v1/cloud/documents/:attachment_id/collab`.
- `GET /v1/cloud/documents/:attachment_id/collab?ticket=…` upgrades to a WebSocket. Binary frames only; message types sync (0) and awareness (1) exactly as `y-websocket` sends them; the server answers sync step 1 with step 2, broadcasts updates and awareness to the other members of the room, and closes with 4401 on a bad ticket, 4403 when access was revoked, 4409 for unsupported messages.
- Awareness state from clients is `{ "user": { "name", "color", "accountId" } }` plus the caret the extension adds; the server forwards it unchanged and clears a client's awareness on disconnect.

### Seeding and snapshots

- `POST /v1/cloud/documents/:attachment_id/collab/init` answers `{ "initialize": true, "revision" }` to exactly one caller while `initialized_at` is null (compare-and-set with a 30 second grant that expires if no update arrives); everyone else gets `{ "initialize": false }` and waits for sync. The grantee builds the Y document from the Markdown at that revision (block ids included), and the first update the room applies sets `initialized_at`.
- While a room is in use, Markdown snapshots are written with `PUT /v1/cloud/documents/:attachment_id/content` and `"mode": "snapshot"`: no `baseRevision` check, the revision increments only when the source differs from the stored one, annotations are remapped as for a save, and `document.updated` carries `"change": "content"`. The connected editor with the smallest awareness client id writes the snapshot, debounced 2 seconds after the last update and on disconnect; duplicates from other editors are harmless.
- A save with `baseRevision` from a client that is not in the room (older build, offline edit) is still accepted and applied to the Y document by the server: it rebuilds nothing itself; instead it marks the room `stale_revision` and the next connected editor reconciles by replacing blocks whose Markdown changed. This keeps the Y document authoritative while a room exists.

### Clients

- Mac: the reader joins the room when the document is editable and the viewer is signed in; the Collaboration extension binds the editor to the room's `Y.XmlFragment` named `document`; carets show other editors with their name and color; the header shows the connected people. Without a socket (offline, ticket refused) the editor falls back to revisioned saves as before and rejoins when possible.
- iPhone: snapshots only in this phase; it refreshes on `document.updated` as today.
- Public page: snapshots only.
- The session agent edits through the room in a later phase.

## Agents in documents (added 2026-10-12)

Agents read shared documents, answer when mentioned in a comment, and edit the document when the person who owns the agent delegates the edit. Policy lives on the server; nothing here depends on prompt wording.

### Who can ask which agent

- A signed-in member mentions an agent in a comment or reply with `@<agent name>`. Mentions resolve with the same rules as group mentions (`runs/group_mentions.rs`): the commenter's own default or named agent, or another member's agent that is shared into the document's session. An ambiguous or unknown name is not a mention.
- A public reader's mention only reaches the document owner's default agent, only while the share's `readersCanAskAgent` is on, and runs on the owner's quota.
- Every run is charged to `observe_agent_run` for the requester (the owner for public readers) and refused with `429` like other agent runs.

### Run

- A comment that mentions an agent creates one run in `cloud_agent_fallback_runs` with `request_message_id = "doccmt:<commentId>"`, the document's session as `session_id`, the agent's owner, the requester, and a new nullable column `document_comment_id` (migration `0127_cloud_document_agent_runs.sql`, which also adds `author_agent_id` and `author_agent_name` to `cloud_document_comments` and relaxes its author check so exactly one of account, reader key, or agent is set). Idempotent per comment and agent.
- Execution follows the existing routing (the owner's Mac when it claims the run, else the cloud runner). The run's trigger is person-started only when the requester owns the agent, exactly as `RunTrigger::for_person_message` decides for chat.
- The prompt is built by the server: the document title, the Markdown of the block the thread is on with the two blocks before and after, the thread so far, and the request. The full document is not inlined; the agent reads it with the tool below.
- On completion the response text becomes a reply comment in the same thread with the agent as author (`author: { displayName, agentId, ownerAccountId }`, `kind: "agent"` on `DocumentComment`), not a chat message, and `document.updated` with `"change": "annotations"` is published. On failure the thread gets a short system reply ("<Agent> could not answer.") so the "is working" state ends. `DocumentComment` gains `agentRun: { status: "queued" | "running" | "completed" | "failed" } | null` on the mentioning comment so clients show "is working" from data.

### Tools

Delivered to both runtimes the way connector tools are (host tools carried in `request.tools`, executed by the server under the run lease; no token reaches the run):

- `read_document` (always): `{ attachmentId?, includeComments? }` returns the current revision, title, and blocks `[{ id, markdown }]`, optionally the open threads. Defaults to the run's document. Also available to ordinary chat runs in a session that carries a document, so agents can read shared documents outside comments; access requires the agent's owner and the requester to be active members of a conversation carrying the document family. HTML documents return extracted text in one block, capped at 200 kB.
- `edit_document` (only in person-started runs where the requester can edit the document; never for public readers, never for background or scheduled runs): `{ baseRevision, operations: [{ op: "replace" | "insert_after" | "delete", blockId, markdown? }] }`. The server applies the operations to the stored Markdown in one transaction with the revision check, keeps block ids of untouched blocks, stamps new blocks, remaps annotations, records `updated_by_account_id` as the requester and `updated_by_agent_id`, marks the collaboration room stale so connected editors reconcile, and publishes `document.updated` content. A stale `baseRevision` returns the current blocks so the agent can retry once. At most 20 operations and 200 kB per call.
- The agent's reply says what it changed; the server appends nothing on its own.

### Server choices (added 2026-10-12 with the implementation)

Points the sections above left open, as built in `document_shares/agents/`:

- **Mentions.** A handle is the agent's name, optionally followed by its owner's name, compared like group handles (NFKC, letters and digits only), so names with spaces work. The commenter's own default agent also answers to `@agent`, `@Kordi`, and `@my Kordi`. Another member's agent is reachable only when it is a named agent with access scope `participant_conversations` whose owner is an active member of the document's session; another member's default agent is not reachable from a comment. Two different agents in one comment are not a mention. A document that no conversation of the requester carries has no session, so its comments start no run.
- **Charging.** The mention is resolved and `observe_agent_run` is charged before the comment is stored; a `429 rate_limited` leaves no comment. A repeat of the same body by the same author on the same block and parent, while the earlier run for that agent is still queued or running, is stored without a second run (`agentRun` is `null`).
- **Routing.** Comment runs are queued for the cloud runner (`execution_backend = 'cloud'`, connector audience `shared`, so no connector tools). The desktop claim path starts from a chat message, so no Mac claims a comment run yet. A stopped run reads as `failed` without a system reply.
- **Comment shape.** `DocumentComment.kind` is `"person"`, `"agent"`, or `"system"` (the "could not answer" reply, which is stored with the agent as author). The reply's parent is the root of the mentioning comment's thread. On public routes an agent author carries only `displayName`: no `agentId`, `ownerAccountId`, or avatar, because all three contain the owner's account id. The run stores the reply's comment id in `response_message_id`.
- **Tool delivery.** The two tools are entries of the lease's `connectorTools` with `connectorId: "kordi-documents"` and `provider: "kordi_documents"` (`read_document` in group `read`, `edit_document` in group `act`, which the cloud lease keeps for this provider), and calls come back through `POST /internal/connectors/call`. The gate is evaluated when the lease is first delivered and again on every call. On the Mac, lease tools are offered only in turns the owner requested, so a chat run another member started gets `read_document` from the cloud runner only.
- **`read_document`.** Result `{ attachmentId, title, format, revision, blocks: [{ id, markdown }], threads?: [{ blockId, comments: [{ commentId, author, byAgent, body, createdAt }] }], truncated?: true }`. Markdown is cut at 200 kB like HTML text. In a chat run without `attachmentId`, the session's only document is read; with several, the result is `{ documents: [{ attachmentId, fileName }], message }`. A document the run may not read answers `document_not_found`, the same as a missing one.
- **`edit_document`.** Offered to comment runs only (it edits the run's document; chat runs never get it). Operations address blocks of the base revision and are applied whole or not at all; a replaced block keeps its id, or is given a stable id when it had only an index id, so its annotations follow it. Result `{ applied: true, revision, blocks, newBlockIds }`, or for a stale base `{ applied: false, reason: "stale_revision", revision, blocks }`. Errors: `invalid_request` (unknown block, limits, bad shape), `document_tool_forbidden`, `tool_not_on_lease`, `lease_invalid`.

### Clients

- Threads render agent replies with the agent's avatar and name and an "Agent" tag; the mentioning comment shows "<Agent> is working" while `agentRun.status` is queued or running, and "Could not answer" with Retry (re-post) on failed.
- The reply field under a thread that has an agent reply offers **Ask <Agent> to edit**, which prefixes the reply with the mention; edits arrive through the normal document update path with a one-line "Edited by <Agent>" notice in the thread.
- The Share switch **Readers can ask <Agent>** now controls real behavior.

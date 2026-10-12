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

# Issue 1741: document editor proposal

Status: proposal, 2026-10-12, after the live test of the shared-document reader on the Mac. Tracks [#1741](https://github.com/Kordi-Lab/Kordi/issues/1741).

## What the live test showed

The current reader renders Markdown and edits it through two bridges: a text selection in the rendered view is mapped back to source offsets with a heuristic projection (markers and whitespace stripped, n-th occurrence matched), and a click turns one block into a raw-source editor. Both bridges are the cause of what the user saw:

- Formats land mid-word (`~~assistants that answe~~`, `==Shared sessions change tha==`) because the projection and the renderer disagree about which characters exist once a block already carries marks.
- Inserted code blocks, tables, and checklists render as placeholders in boxes instead of real editable blocks.
- Typing switches a paragraph between rendered and raw Markdown, which moves the eye and the caret.
- Comments and reactions key on block indexes, so an insertion shifts them until the server remaps.
- Saves send the whole document per revision; two people typing in the same document produce conflicts instead of merged keystrokes, and there are no cursors or presence.

## How shared documents work elsewhere

- **Slack canvas** comes from Quip: a block editor with typed blocks (headers, checklists, dividers, embeds) and live co-editing where the other person's text arrives as they type; comments and threads attach to the canvas ([Fast Company on the Quip origin](https://www.fastcompany.com/90790528/the-unexpected-story-behind-slacks-new-canvas-feature), [Slack expanded rich text type](https://docs.slack.dev/reference/types/expanded_rich_text-type)).
- **Lark Docs** is a block tree where every block is its own collaborative document under operational transformation; comments anchor to blocks and ranges, and the toolbar floats on the selection.
- **Claude Docs** is a block document (headings, pending blocks, mentions) with threaded comments per block and an agent that edits the same blocks.

All three share the same shape: a WYSIWYG block editor with no source mode, a floating toolbar on the selection, a slash menu for inserting blocks, stable block identities, range-anchored comments, and keystroke-level synchronization with cursors.

## Proposal

Replace the two bridges with a real editor and keep Markdown as the exchange format for the server, the public page, and the iPhone.

### Editor

[Tiptap](https://tiptap.dev) (ProseMirror, MIT) with the official [`@tiptap/markdown`](https://tiptap.dev/blog/release-notes/introducing-bidirectional-markdown-support-in-tiptap) extension for bidirectional Markdown. ProseMirror gives exact selections, marks that cannot land mid-token, real block nodes (code block with language, table with cell editing, task list), undo history, paste handling, and IME support. Tiptap's packages are tree-shakable and it is the editor LiveBlocks and Tiptap Cloud build collaboration on; the comparison in [Liveblocks' 2025 review](https://liveblocks.io/blog/which-rich-text-editor-framework-should-you-choose-in-2025) is the reference.

- Marks: bold, italic, strike, code, link, plus two custom marks `underline` and `highlight` serialized as `<u>` and `==` (the server already renders both).
- Nodes: paragraph, heading 1 to 3, blockquote, bullet, ordered and task lists, code block, table, image, horizontal rule.
- Floating bubble menu on a non-empty selection (translucent surface, follows the selection, flips when there is no room) with the same buttons the reader has today; comment and react act on the block that contains the selection.
- Slash menu (`/`) and the tab-bar insert tools create real blocks at the caret.
- Read-only viewers get the same editor with `editable: false`, so rendering is identical.
- Block identity: Tiptap's `UniqueID` extension stamps every top-level block; the Markdown serializer emits the id as a trailing HTML comment `<!-- k:b7a3 -->` that the server strips before rendering and keeps as the block id. Comments and reactions move from index ids to these ids; the server's index remap becomes unnecessary.

### Synchronization

- **Phase 1** keeps the revisioned whole-document save that exists today (`PUT /content` with `baseRevision`, `document.updated`). The editor applies remote updates by diffing ProseMirror documents, so a remote change outside the block being typed never moves the caret.
- **Phase 2** adds Yjs: the ProseMirror document becomes a `Y.XmlFragment`, the Mac and later the iPhone exchange Yjs updates over the existing realtime socket, and the server appends updates to a per-document log, compacts them, and writes a Markdown snapshot per revision for the public page, the iPhone reader, search, and the agent. Awareness carries cursors and presence. This is the keystroke-level co-editing Slack and Lark offer.

### iPhone and the agent

The editor bundle is shared: the iPhone reader loads it in a `WKWebView` with scripts enabled only for the app-bundled editor (not for shared HTML files), so editing is identical on both devices. The session agent edits through the same Yjs document, which is what "ask the agent to edit" in the issue comment needs.

## Plan

| Phase | Scope | Estimate |
|---|---|---|
| 1 | Tiptap editor in the Mac reader, Markdown round-trip, bubble and slash menus, real blocks, block ids, comments and reactions on ids, whole-document saves | 1 week |
| 2 | Yjs sync through the realtime socket, server update log and snapshots, cursors and presence | 2 to 3 weeks |
| 3 | Shared editor bundle on the iPhone, agent edits through Yjs | 2 weeks |

## Risks

- Bundle: about 300 KB gzipped for Tiptap core plus extensions; loaded lazily with the reader.
- Markdown fidelity: nested lists, tables with inline formatting, and HTML in old documents need round-trip tests; documents the editor cannot represent open read-only with a notice.
- Yjs log growth: compaction after every snapshot and a cap per document.
- The public page and the server-side sanitizer are unchanged; the block id comments are stripped before rendering.

## Decision needed

Adopt Tiptap for the reader (phase 1) now, or keep the current bridges and only fix the offset bug. The offset bug is structural: the projection cannot be made exact without re-implementing the renderer, which is what the editor provides.

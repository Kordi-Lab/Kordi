# Shared documents proposal

Standalone, interactive design preview for [issue #1741](https://github.com/Kordi-Lab/Kordi/issues/1741) using synthetic people, a synthetic Kordi ID, and a placeholder share token. No API calls, account data, or messaging side effects. Open `index.html` through a loopback static server.

Three modes share one document: the iPhone reader and share sheet, the Mac Artifacts panel with its Share popover and the **On this Mac** upload step, and a friend's Safari view of `kordi.ai/d/<token>` without an account. The reader shows the title, a date pill, and an `@author` mention chip that opens a People card. Selecting a paragraph shows the floating menu; reactions appear as pills and comments inline under the paragraph. Comments can mention the session agent, and Share has a **Readers can ask the agent** switch.

The implemented surfaces live in `bridges/cloud-server/src/document_shares` (server), `app/desktop/src/features/documents` (Mac), and `app/ios/Kordi/Features/Documents` (iPhone). The API contract is in `docs/development/issue-1741-shared-documents.md`.

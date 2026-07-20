# Desktop transient surface inventory

Issue: [#718](https://github.com/Kordi-AI/Kordi/issues/718)

The compact **Start a chat** popover is the visual reference. Every Kordi-owned popup, menu, dialog, and auxiliary window below now uses the shared `--app-transient-*` tokens and `app-transient-*` surface/state classes. Component-owned dimensions and information architecture remain unchanged where their jobs differ.

## Shared contract

- [x] Cool neutral, near-opaque surface plus an opaque fallback
- [x] Raised, hover, selected, disabled, focus, error, and destructive states
- [x] Shared border, divider, overlay, text, icon, and shadow hierarchy
- [x] Dark and light values available from both `.bridge-app` and `body` for portaled menus
- [x] Thin themed scrollbars for long selector and menu content
- [x] Forced-colors fallback
- [x] Existing Escape, outside-click, focus trapping, and focus restoration behavior retained

## Reviewed surfaces

| Area | Surface or state | Implementation | Status |
| --- | --- | --- | --- |
| Global create | Start a chat and New chat launcher | `ChatCreateDialog` | [x] Reference migrated to shared near-opaque surface and row states |
| Create flows | Contact, group, project, move-to-project, and rename forms | `ChatCreateDialog`, `AppDialog`, `SessionActionOverlays` | [x] Shared popup/modal shell; specialized form layout retained |
| Agent create | New agent flow, loading, validation, and footer actions | `AgentCreateDialog` | [x] Shared modal, overlay, dividers, and raised content hierarchy |
| Session actions | Context menu, rename, move, remove confirmation, failure, and busy states | `SessionActionOverlays`, `AppDialog` | [x] Shared compact rows; destructive and disabled states explicit |
| Message actions | Reply, copy, forward, detail, select, pin/unpin, and seen state | `transcript.tsx`, `ChatsPage` | [x] Shared menu/dialog surface and selected rows |
| Message branching | Fork list and session destinations | `transcript.tsx` | [x] Shared menu, row, muted metadata, and overflow treatment |
| Forwarding | Single/batch destination picker, caption, empty state, and actions | `MessageForwardDialog` | [x] Shared dialog, overlay, fields, dividers, and selection state |
| Attachments | Image context actions, progress/error copy, and image lightbox | `transcriptAttachments.tsx` | [x] Shared menu and auxiliary frame; media remains the visual content |
| Composer commands | Slash-command results and empty/scroll states | `composer.tsx` | [x] Shared compact surface and keyboard-selected rows |
| Composer mentions | Person and agent mention results | `composer.tsx` | [x] Shared portaled surface, icons, hover, and selection states |
| Composer routing | Compact route, provider, account/auth, model, thinking, and compose-mode selectors | `composer.tsx` | [x] Shared portaled surface, header, selected rows, save action, and long-menu scrolling |
| Composer status | Context-window tooltip and threshold/error notices | `composer.tsx` | [x] Shared utility popout; status accents retained inside it |
| Ask Agent | Side-chat options, session switcher, agent routing, model routing | `ChatsPage`, `ComposerModelControls` | [x] Shared menus while the parallel Ask Agent layout remains unchanged |
| Profile | Cloud account and local profile popovers, copy feedback | `WorkspaceSidebar` | [x] Shared near-opaque shell and neutral rows; success/error feedback retained |
| Updater | Checking, available, progress, success, failure, and disabled actions | `WorkspaceSidebar` | [x] Shared shell with updater-specific status accents inside |
| Authentication | Inline provider auth and detached auth window | `AuthPopup`, `assembleOverlaySlots` | [x] Shared modal/overlay hierarchy; OAuth browser windows excluded |
| Account/settings | Account settings modal and provider/settings subpages | `CloudAccountSettingsDialog` | [x] Shared cool-neutral modal; internal navigation and full-page layout retained |
| Contacts | Contact details, request review, add-contact lookup, loading, empty, and error states | `pages.tsx`, `CloudContactsPanel` | [x] Shared modal, rows, fields, and state hierarchy |
| Group management | Members, add member, admin, remove, empty, and overflow states | `GroupDetailsDialog` | [x] Shared anchored surface and semantic row states |
| Agent management | Delete confirmation, action menu, routing listbox, and selected state | `AgentDetailPane` | [x] Shared modal/menu/listbox and destructive state |
| Bridge | Remove-host confirmation and setup wizard | `BridgeConfigModals` | [x] Shared modal/overlay; setup steps and status accents retained |
| Peer auxiliary chat | Cloud peer conversation window, empty/loading/error states | `CloudPeerChatPanel` | [x] Shared auxiliary shell and controls; chat bubbles remain conversation-specific |
| Artifacts/source | Artifact preview window, header, body, and backdrop | `ArtifactInspector` | [x] Shared detached auxiliary shell; code/media preview palette remains content-specific |

## Nested and platform review

- [x] Portaled menus resolve their theme from `body.theme-light` / `body.theme-dark`.
- [x] Modal-over-popover and nested selector surfaces use the same border and shadow hierarchy.
- [x] Menu bodies are near opaque; transcript text behind them is not readable.
- [x] Operating-system file pickers, permission prompts, and external OAuth browser windows are intentionally unchanged.

## Native QA checklist

- [ ] Light mode at default desktop size
- [ ] Dark mode at default desktop size
- [ ] Light mode at compact desktop size
- [ ] Dark mode at compact desktop size
- [ ] Keyboard focus, Escape, outside click, and focus restoration
- [ ] Long model/mention/session lists and nested popup stacking

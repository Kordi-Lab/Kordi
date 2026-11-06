# Browser alignment with the main-branch desktop

## Reference and method

The user selected the latest main-branch desktop UI as the reference. The initial
audit used `103f9bf5d` (2026-11-05 audit). The web workspace extraction was rebased
onto main commit `5676f9fda`. The older, modified local checkout is not the target.
This work preserves its changes independently.

The browser imports the actual desktop page composition. This audit traces
visible controls to their handlers and storage/HTTP contracts, compares rendered
full pages at desktop and phone widths, and exercises the compiled browser app.
Browser API fixtures and synthetic microphone input are explicitly synthetic;
they do not prove live OAuth, hosted execution, or call-service acceptance.
No production service or account was inspected or modified.

## Corrections made by the alignment audit

- Share the desktop titlebar, chat title/action portals, companion title slots,
  compact surfaces, radii and spacing. Remove the separate browser heading that
  duplicated the conversation title. Native dragging and traffic-light clearance
  stay native; a narrow browser wraps the same controls without covering tabs.
- Keep the real Contacts, Chats, Agent Chats, Factory and Digest navigation,
  original labels, icons, order and destination capability rules.
- Render real Authentication settings in the browser rather than the development
  preview note. Refresh hosted accounts through their server APIs.
- Allow hosted model/account/thinking selection and default hosted routes. Never
  substitute credentials or local models from a Mac in a browser.
- Create new and companion Agent Chats through scoped canonical session storage
  instead of silently returning from native-only handlers.
- Enable browser file upload in the companion composer and document reader,
  authenticated cloud artifact preview and browser Save As.
- Enable real microphone recording with browser media APIs, WAV conversion,
  preview/trim, cancellation and cleanup. Extend the server voice MIME validators
  for the actual WAV payload rather than relying on a permissive fixture.
- Resolve Digest calendar-import assets under the browser application base.
- Persist browser-owned session renames to the hosted title API and restore them
  through the authoritative title projection after refresh.
- Preserve group-avatar editing through the real cloud profile route.
- Restore Memory in the synthetic review server by advertising its implemented
  memory capability and supplying the matching account-memory protocol. The
  shared UI intentionally hides Memory when the server does not advertise it;
  the initial review fixture omitted that capability. This was a preview setup
  omission, not deletion of account memories.
- Report unsupported transcript forking explicitly rather than silently ignoring
  the action. Finder commands require the desktop filesystem capability.

## Page and capability matrix

| Surface | Alignment evidence | Remaining qualification or difference |
| --- | --- | --- |
| Shell, navigation, theme | Shared desktop composition, titlebar and visual styles; full-page desktop/phone rendering | Browser uses the shared opaque material fallback; macOS vibrancy, window dragging and traffic lights are OS capabilities |
| Contacts | Shared profile/detail UI and existing account APIs; contact-to-message navigation exercised | Live contact invitations and cross-account acceptance need configured development service checks |
| Chats | Shared transcript/composer/tabs/header; cookie protocol, scoped history/outbox, send/upload/refresh exercised | Full long-offline/reconnect and peer attachment access still need live acceptance |
| Agent Chats | Shared page, hosted default/model route, canonical session creation, authoritative rename | Hosted stream/stop/recovery must be verified with a real configured runner; local execution requires desktop |
| Artifacts/documents | Shared reader/editor, browser add/upload/download and cloud-backed preview | Arbitrary local files/folders and Finder are native; simultaneous peer editing/revocation still needs live checks |
| Tasks | Shared Tasks destination and hosted task clients | Full scheduled execution lifecycle has not passed live-service acceptance |
| Memory | Signed-in CRUD, categories, settings and forget-all use cloud APIs | Desktop memory discovery/choose/extract importer has no browser implementation |
| Digest/calendar | Shared overview/calendar; real ICS parser and import flow | Live calendar authorization and updates still need provider acceptance |
| Authentication | Shared provider settings; hosted API key/account/login paths; browser refresh | Automatic localhost OAuth callback capture and local model setup are native; real provider round trips remain unverified |
| Profile, organizations, devices | Shared forms and actual profile/org/device APIs; org-switch isolation exercised | Full live edit/revoke/invite walkthrough remains unverified |
| Notifications | Shared preferences with browser Notification permission API | Dock attention and macOS notification settings are native; browser background delivery is not certified |
| Voice messages | Shared recorder/review/send UI with actual browser audio and supported server payload | On-demand local transcription remains desktop-only; physical microphone testing remains outstanding |
| Voice/video calls | Shared call controls and existing browser media/signaling path | Real permissions, devices, peers and reconnect require configured media-service checks |
| Factory catalog | Existing hosted agent list and definition APIs | Building, testing, editing builder workspaces and publishing still depend on native builder commands |
| Help/legal | Shared help and license content, application-base asset resolution | No native updater in a browser |

## Confirmed blockers to full behavioral parity

1. Factory is not fully functional in the browser. `useAgentBuilderSession`,
   `desktopAgentBuilderCatalog` and `desktopAgentBuilderTest` invoke native
   builder commands. A hosted test lease does not execute the test in a browser.
   Publishing also checks builder status and retargets/marks the native builder;
   the hosted definition API alone does not complete that UI workflow.
2. Transcript Fork lacks a browser snapshot-creation implementation. Publishing
   fork metadata alone is insufficient. The action must not claim success.
3. Memory import and on-demand audio transcription require native extraction or
   inference capabilities. Browser alternatives are not implemented.
4. Legacy native/cloud transcript convergence needs additional acceptance and
   equivalent provenance handling. Native mirror reconciliation rewrites references
   and cache state beyond the browser matching-request path.
5. Real OAuth, hosted agents, calls, collaborative documents and complete
   two-account workflows still require live development-service qualification.

These are explicit gaps, not completed parity. Do not describe the browser as
fully equivalent to desktop until the applicable gaps are implemented and tested.
Platform-specific OS controls should remain clearly identified rather than
imitated with nonfunctional buttons.

## Validation

Detailed runtime references and capability boundaries are also recorded in
[Browser runtime capabilities](capabilities.md).

- Web workspace extraction: all 51 browser unit tests pass from `app/web`.
  The full Chromium/WebKit run passed 36 cases and skipped the WebKit synthetic
  microphone case. One WebKit chat case reported canceled sync fetches during
  page reload; its unchanged focused rerun passed. All 37 runnable cases have
  passing evidence. Desktop and compact screenshots confirm shared styles still
  load from the new workspace, including navigation, chat controls, and Memory.
- Memory review correction: six browser checks passed across Chromium and
  WebKit for Settings visibility, read/edit/create/reload, the scoped chat
  Memory tab, and servers without memory capabilities. The shared memory client
  and settings unit suites passed 29 tests. Full Settings screenshots use
  explicitly synthetic memories; real account data was not accessed.
- Compiled browser: all 31 runnable cases passed across Chromium and WebKit.
  The broad run passed 27; after fixing the new-session metadata contract, the
  four Agent Chat/companion cases passed targeted reruns in both engines.
  A final 10-case layout run also passed and recorded computed theme values: the
  Classic backing is `#f7f7f7`, and navigation colors match desktop button tokens.
  One WebKit synthetic-microphone case is skipped; Chromium verifies real
  browser capture, WAV bytes, upload and voice-message content.
- Tests assert the complete navigation inventory, computed link/button color
  agreement, rendered Classic theme, 1440-pixel and 390-pixel layouts, titlebar
  controls, contact-to-chat navigation, hosted rename/reload, empty new chats,
  separate companion composers, Authentication save/refresh, document creation,
  attachment delivery and ICS import using the real parser worker.
- TypeScript unit suite: 1,799 passed. Component suite: 2,964 of 2,965 passed on
  the broad concurrent run; the clock-sensitive Ask Agent replay case passed
  its three-test focused rerun unchanged. Additional shared titlebar, hosted
  default route and real canonical session projection checks passed 16 tests.
- Backend audio validation: six focused Rust tests passed; metadata and finalized
  attachment checks use the same supported-audio MIME policy.
- Both build targets retain their size budgets. TypeScript, frontend lint,
  Rust formatting/strict Clippy, privacy, English-only and maintainability checks
  pass. Obsolete lint debt was removed without adding suppressions. No deployment, native live-session comparison or real-service parity
  certification is implied by these fixture checks.

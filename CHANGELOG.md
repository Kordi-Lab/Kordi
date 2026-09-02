# Changelog

This file records notable user-facing changes to Kordi Desktop.

## [Unreleased]

## [0.0.1-beta.19.1] - 2026-09-02

### Added

- Added threaded replies across macOS and iOS with synchronized drafts, agent
  progress, failures, cancellations, and hosted responses. ([#1323])
- Added native macOS and iOS call experiences with incoming-call handling,
  device switching, minimized controls, and improved video presentation.
  ([#1321])
- Added a macOS menu-bar unread count that restores and focuses Kordi when
  selected. ([#1300])

### Changed

- Gave each default agent a stable editable identity across devices and made
  agent availability reflect its owner Mac runtime without changing human
  presence. ([#1297], [#1329])
- Made message editing, deletion, archiving, and pinning respond immediately
  while retaining rollback and server reconciliation. ([#1310], [#1354])
- Refined media presentation with a navigable iOS gallery and correctly shaped,
  aligned standalone images. ([#1307], [#1315])
- Added CDN-backed range delivery and verification for more reliable desktop
  update downloads. ([#1306])

### Fixed

- Reconciled unread totals across macOS and iOS and cleared visible-chat badges
  immediately without allowing stale snapshots to restore them. ([#1318],
  [#1338])
- Restored group membership, titles, catalogs, and active history across fresh
  profiles and multiple channels. ([#1298], [#1324], [#1344], [#1348],
  [#1350])
- Restored Blob Emoji in the iOS catalog and rendered them consistently in
  composers, previews, messages, reactions, and notification fallbacks.
  ([#1301], [#1309])
- Kept agent replies in stable order and made synchronized Agent sessions
  archive through the correct Cloud path. ([#1340], [#1341])
- Stabilized iOS conversation entry, refresh, archive, restore, pin, and delete
  flows while keeping contacts and archived groups navigable. ([#1345],
  [#1355], [#1358])
- Corrected sidebar activity timestamps, Support classification, and expanded
  row measurement. ([#1312], [#1352])
- Preserved sidebar position when group activity reorders chats and kept newer
  incoming messages unread after an earlier message is read. ([#1363])
- Kept unread badges aligned beside sidebar timestamps. ([#1365])
- Prevented iOS chat rows from leaving placeholders or overlapping during pin
  changes, and made Contacts open conversations with native navigation.
  ([#1372])

## [0.0.1-beta.18] - 2026-08-31

### Added

- Added version-checked editing for your own messages plus **Delete for me**
  and **Delete for everyone** across macOS and iOS, including direct and group
  conversations, confirmation flows, and edited markers. ([#1289])
- Added saved sticker and GIF deletion from the macOS context menu and iOS
  long-press menu while preserving synchronized media types. ([#1275])

### Changed

- Improved chat contrast across themes and aligned iOS reaction chips with
  their sender avatars. ([#1273], [#1278], [#1280])
- Refined outgoing desktop message feedback and transcript motion while
  preserving reduced-motion behavior and stable scroll position. ([#1288],
  [#1290])
- Moved Blob Emoji delivery out of the desktop bundle and into immutable hosted
  assets with durable native caching, substantially reducing download size
  while preserving previously used emoji offline. ([#1287])
- Removed meme-creation shortcuts from the macOS and iOS composer menus while
  preserving existing meme messages, forwarding, and synchronization.
  ([#1284])

### Fixed

- Rendered human message Markdown consistently on macOS without losing safe
  links, structured mentions, link previews, or theme-aware colors. ([#1272])
- Restored cache-first iOS avatars without refresh flicker and made
  attachment-only reply previews identify photos, videos, stickers, and GIFs
  on both platforms. ([#1276], [#1283])
- Improved video capture and playback previews across macOS and iOS with
  higher-quality iPhone recording, stable posters, native full-screen iOS
  playback, and resizable macOS playback. ([#1286])
- Kept captioned multi-image groups outside message bubbles on macOS and iOS
  while preserving borderless image-only messages and sender alignment.
  ([#1292])

## [0.0.1-beta.17] - 2026-08-29

### Added

- Added file-backed inline video recording, sending, playback, retry, and
  forwarding across macOS and iOS. ([#1241])
- Added bounded rich-link previews on macOS and iOS, plus native iPhone sharing
  into and out of Kordi. ([#1255])
- Opened contact cards from human avatars and structured person mentions in
  group conversations. ([#1228])

### Changed

- Refined voice recording with a deliberate hold-to-record interaction,
  release-to-send, cancellation, transcription, and sub-second discard across
  iOS and macOS. ([#1217])
- Improved chat hierarchy and interactions with clearer grouped-session rows,
  readable expressive-media previews, reliable message gestures and text
  selection, simpler group previews, and visible grouped sender names.
  ([#1213], [#1219], [#1224], [#1231], [#1239], [#1256])

### Fixed

- Restored synchronized private and shared pins and stabilized cached, cold-start,
  and paged conversation history across macOS and iOS without transcript flashes,
  duplicate shells, input loss, or scroll instability. ([#1216], [#1226],
  [#1230], [#1237], [#1258])
- Isolated side-panel attachment drafts, repaired sticker and GIF upload and
  synchronization, preserved media geometry while loading, and made every iOS
  photo tile reliably tappable. ([#1212], [#1236], [#1244], [#1254])
- Kept failed tool calls available as diagnostics rather than treating them as
  fatal, recovered stopped turns, and prevented late activity from reviving
  cancelled iOS responses. ([#1215])
- Made agent authentication routes portable across devices and cleared stale
  provider, model, and thinking selections after disconnecting. ([#1235])
- Repaired malformed and legacy Kordi Support conversations while preserving
  valid history and merging newly delivered Support messages. ([#1240],
  [#1243], [#1245])
- Kept Seen receipts and reactions monotonic across stale snapshots, cached
  messages, retries, and transcript updates on macOS and iOS. ([#1224],
  [#1251], [#1258])
- Restored the native macOS notification permission flow and made installed
  updates relaunch reliably through LaunchServices. ([#1220], [#1221])

## [0.0.1-beta.16] - 2026-08-22

### Fixed

- Completed desktop OAuth loopback request bodies before parsing the returned
  session and preserved hydrated Kordi Support routing when legacy history is
  selected.
- Moved uploaded person and Agent avatars to bounded reference-backed assets,
  restored group sends that previously exceeded the message limit, and kept
  group avatar stacks pinned to the first three human members. ([#1179],
  [#1181])

## [0.0.1-beta.15] - 2026-08-22

### Changed

- Restored support for macOS 12 and later while keeping the iPhone companion
  on iOS 17 and later.

## [0.0.1-beta.14] - 2026-08-21

### Added

- Added resumable attachment uploads up to 2 GiB with bounded memory, visible
  progress, cancellation, retry, and restart recovery across macOS and iOS.
  ([#1068])
- Added canonical synchronized avatars for people and agents across Factory,
  conversations, mentions, profiles, calls, macOS, and iOS. ([#1076])

### Changed

- Raised the Kordi Desktop minimum system requirement to macOS 15. ([#1102])
- Promoted Agents and Account to root iPhone destinations, moved secondary
  destinations into full-page navigation, and refined compact floating menus
  and agent model selection. ([#1080], [#1081])
- Reworked grouped-image messaging with bounded macOS stacks, native iOS photo
  review, real image layers, accessible browsing, and attached delivery and
  retry feedback. ([#1079])
- Replaced the hosted edge port-forward with a loopback-only NodePort so
  healthy Cloud pods remain reachable without a stale userspace tunnel.
  ([#1075])

### Fixed

- Restored Kordi Support and hosted call media, then made call lifecycle state
  monotonic across delayed polls, events, joins, and media callbacks with
  clearer connection diagnostics. ([#1057], [#1060], [#1082])
- Fixed Factory publishing, avatar controls, custom-agent identity and routing,
  owner-Mac execution, and cross-device session repair without replaying
  completed local work. ([#1074])
- Isolated cached iPhone timelines by account, preserved history and composer
  positioning, and aligned durable group-member join notices with macOS.
  ([#1077], [#1084])

## [0.0.1-beta.13] - 2026-08-18

### Added

- Added the native iPhone companion with Contact and Agent chats, Digest,
  Ask Agent, session details, calls, expressive media, participant profiles,
  and synchronized presence. ([#957], [#1018], [#1021], [#1025], [#1034],
  [#1041], [#1043])
- Added public Kordi IDs, app invitations, and secure group invitation links
  with explicit membership and authorization handling. ([#923], [#927],
  [#945])
- Added active-device review and revocation, plus native macOS and iOS audio,
  video, and group-call history. ([#1015], [#1025], [#1032])
- Added version-aware What’s New presentation and native media gallery
  previews. ([#937], [#1017])

### Changed

- Completed the reliable chat sync v2 cutover and made it the canonical
  session/message foundation while isolating development OAuth, data, and
  branding from production. ([#980], [#989], [#991], [#995])
- Refined desktop chat hierarchy, transcript disclosure, message width and
  timestamps, split-pane geometry, sidebar status, media previews, selection,
  focus, transient surfaces, and avatar identity. ([#901], [#903], [#920],
  [#935], [#939], [#942], [#952], [#955], [#956], [#1013], [#1014], [#1038])
- Simplified contact requests and aligned contact/group profiles and last-seen
  status across macOS and iOS. ([#1010], [#1012], [#1034], [#1041])
- Unified product branding across OAuth, invitation, and hosted entry
  surfaces. ([#927], [#951])

### Fixed

- Made group handoffs, self-agent replies, terminal state, and selected runtime
  routes converge across devices without duplicate execution. ([#924], [#936],
  [#940], [#985], [#1044])
- Stabilized iOS session history, blank Agent sessions, calls, model controls,
  mentions, partial streaming, reasoning/tool presentation, composer input,
  scrolling, delivery receipts, and long-content containment. ([#1016],
  [#1028], [#1029], [#1033], [#1045], [#1050], [#1051])
- Made message attention, read state, and sent/read indicators trustworthy
  across macOS and iOS. ([#1036], [#1050])
- Restored Kordi Support visibility and consistent support-chat presentation.
  ([#941])

## [0.0.1-beta.12] - 2026-08-06

### Added

- Enabled group agents to `@mention` conversation participants and their Kordi
  agents while preserving authorization, attribution, and relevant reply
  history across Cloud runs. ([#896])

### Fixed

- Kept Google and GitHub sign-in available in packaged Cloud builds without
  depending on the development-only capability probe, and limited server
  capability diagnostics to debug previews. ([#894])

## [0.0.1-beta.11] - 2026-08-05

### Added

- Added the built-in Kordi Support contact with explicit, draft-scoped consent
  before report submission, durable ticket intake, and restored terminal ticket
  references across navigation and relaunch. ([#868], [#883], [#891])
- Made Factory Build a chat-first agent creation surface with clearer creation
  state and consistent 24-hour message timestamps. ([#879], [#880])

### Changed

- Improved attachment handling and linked URLs across desktop sessions, with
  clearer previews, forwarding, and interaction behavior. ([#866], [#875])
- Simplified contacts, settings, chat headers, secondary controls, and avatar
  presentation while preserving the shared desktop visual system.
  ([#856], [#859], [#863], [#890])

### Fixed

- Stabilized Cloud and local session reconciliation, unread state, Ask Agent
  sessions, and group-agent terminal delivery so remounts and delayed snapshots
  cannot revive stale UI state. ([#853], [#858], [#864], [#873], [#882])
- Locked Kordi Support routing and kept report processing, consent, and submitted
  approval cards terminal and idempotent across session reopen and app relaunch.
  ([#884], [#889], [#891])
- Restored reply-source navigation highlighting and reliable outside dismissal
  for side-chat menus. ([#869], [#870])

## [0.0.1-beta.10] - 2026-07-31

### Changed

- Consolidated the desktop, Cloud API, OAuth, updater, and immutable release
  artifacts on `https://kordi.ai`. ([#753], [#840])
- Decoupled the Cloud desktop from the legacy Bridges runtime and consolidated
  collaboration state around the canonical Cloud/session model. This removes
  duplicate transport work while preserving direct chats, groups, agents,
  forks, drafts, and synchronized activity. ([#754], [#693])
- Completed the repository maintainability program: large desktop, Cloud,
  runtime, installer, provider, and TUI units now have focused ownership
  boundaries; warning-free Rust, typed linting, hotspot ratchets, and
  partitioned regression suites prevent the same debt from returning.
  ([#693], [#759])

### Fixed

- Preserved fork context and manual session titles across local and Cloud
  reconciliation, preventing older or incomplete snapshots from replacing
  the active conversation. ([#751])
- Converted provider HTTP failures into concise, actionable errors instead of
  displaying raw HTML, retry wrappers, infrastructure details, or unbounded
  upstream response bodies. ([#752])
- Kept newly active sessions sorted first and restored runtime-only Cloud
  direct chats even when an initial backend snapshot is incomplete.
  ([#755], [#757])
- Made release publication fail closed unless both the canonical and legacy
  updater origins return the exact expected manifests, sizes, and checksums;
  failed promotion now restores the previous channel pointer. ([#840])

## [0.0.1-beta.9] - 2026-07-22

### Added

- Rebuilt the Agent workspace as **Factory**, with persistent conversational
  agent and skill building, reviewable drafts, safe publishing, and a Skill
  Library for inspecting, editing, enabling, removing, and discovering
  reusable capabilities. ([#724])
- Added full-page **Messages**, **Info**, **Artifacts**, and **Tasks**
  destinations beneath each session title. Ask Agent keeps an independent set
  of destinations, and changing sessions returns each pane to Messages.
  ([#716])
- Redesigned Group management as a searchable, scalable member popover with
  member profiles, contact actions, creator-owned administration, synchronized
  roles and names, deterministic join notices, and reliable invited-agent
  routing. ([#731])
- Added a loopback-only Docker development backend, safe endpoint guards,
  contributor onboarding, and an allowlisted operator mode without exposing
  production credentials. ([#702], [#712])

### Changed

- Unified macOS navigation, dialogs, menus, provider setup, account settings,
  and agent surfaces around shared light/dark tokens, native frosted glass,
  accessible focus behavior, and flatter visual hierarchy. ([#714], [#721])
- Reworked the light workspace into a consistent near-white surface family and
  preserved opaque fallbacks when Reduce Transparency is enabled. ([#730])
- Flattened ordinary message context-menu actions while preserving hover,
  focus, and destructive states. ([#733])
- Aligned the Chats update and new-chat controls and gave updater states a
  quieter, theme-aware presentation with accessible progress semantics.
  ([#708], [#727])
- Made Factory's selected agent highlight span the rail and kept its creation
  menu inside the narrow sidebar with outside-click and Escape dismissal.
  ([#739], [#740])

### Fixed

- Direct agent requests now start locally without waiting for Cloud preflight
  checks. Provider and execution failures become terminal immediately, and a
  later publication failure cannot rerun the model or restore Processing.
  ([#741])
- New group sessions remain genuinely blank until their first send, cannot be
  duplicated, and no longer borrow the previous session's transcript. ([#728])
- New agent sessions retain their temporary identity while starting, show one
  neutral progress state, and coalesce repeated first sends. ([#719])
- Cloud profile avatars no longer flash generated initials during startup;
  validated images now use shared renderer state and a bounded native cache.
  ([#736])
- Placeholder Cloud title backfills no longer create fake rename notices,
  affect activity timestamps, or keep blank group continuations visible.
  ([#737])

## [0.0.1-beta.8] - 2026-07-17

### Added

- Added an in-app **Check for updates** control with clear checking,
  up-to-date, failure, download, install, and retry states. Kordi no longer
  needs to be restarted to check again. ([#700])
- Added inline renaming for persisted self-agent sessions. Renamed sessions
  keep their stable identity and synchronize through the canonical session
  store. ([#705])

### Changed

- Unified session naming across local runtime, canonical, Cloud, project, and
  fork paths. Low-information prompts such as greetings no longer become
  permanent titles, manual names are protected, and internal session IDs are
  replaced by clear chat-type labels. ([#703])
- Forwarded images and files now remain attached across canonical, direct
  Cloud, and Cloud group conversations. ([#703])

### Fixed

- Made Cloud image delivery durable across upload failures, partial recipient
  delivery, app restarts, and manual retries. Successful recipients are not
  sent duplicates when retrying the remaining delivery. ([#704])
- Replaced the persistent generic sending overlay with image-aware delivery
  feedback, including progress, delivered/read checks, and actionable
  **Failed · Retry** and **Partial · Retry** states. ([#704])

## [0.0.1-beta.7] - 2026-07-16

This release is the comparison baseline for beta.8. See the
[beta.7 release notes] for its packaged artifacts and release details.

[Unreleased]: https://github.com/Kordi-Lab/Kordi/compare/V0.0.1.beta19.1...HEAD
[0.0.1-beta.19.1]: https://github.com/Kordi-Lab/Kordi/compare/V0.0.1.beta18...V0.0.1.beta19.1
[0.0.1-beta.18]: https://github.com/Kordi-Lab/Kordi/compare/V0.0.1.beta17...V0.0.1.beta18
[0.0.1-beta.17]: https://github.com/Kordi-Lab/Kordi/compare/V0.0.1.beta16...V0.0.1.beta17
[0.0.1-beta.16]: https://github.com/Kordi-Lab/Kordi/compare/V0.0.1.beta15...V0.0.1.beta16
[0.0.1-beta.15]: https://github.com/Kordi-Lab/Kordi/compare/V0.0.1.beta14...V0.0.1.beta15
[0.0.1-beta.14]: https://github.com/Kordi-Lab/Kordi/compare/V0.0.1.beta13...V0.0.1.beta14
[0.0.1-beta.13]: https://github.com/Kordi-Lab/Kordi/compare/V0.0.1.beta12...V0.0.1.beta13
[0.0.1-beta.12]: https://github.com/Kordi-Lab/Kordi/compare/V0.0.1.beta11...V0.0.1.beta12
[0.0.1-beta.11]: https://github.com/Kordi-Lab/Kordi/compare/V0.0.1.beta10...V0.0.1.beta11
[0.0.1-beta.10]: https://github.com/Kordi-Lab/Kordi/compare/V0.0.1.beta9...V0.0.1.beta10
[0.0.1-beta.9]: https://github.com/Kordi-AI/Kordi/compare/V0.0.1.beta8...V0.0.1.beta9
[0.0.1-beta.8]: https://github.com/Kordi-AI/Kordi/compare/V0.0.1.beta7...V0.0.1.beta8
[0.0.1-beta.7]: https://github.com/Kordi-AI/Kordi/releases/tag/V0.0.1.beta7
[beta.7 release notes]: https://github.com/Kordi-AI/Kordi/releases/tag/V0.0.1.beta7
[#700]: https://github.com/Kordi-AI/Kordi/pull/700
[#702]: https://github.com/Kordi-AI/Kordi/pull/702
[#703]: https://github.com/Kordi-AI/Kordi/pull/703
[#704]: https://github.com/Kordi-AI/Kordi/pull/704
[#705]: https://github.com/Kordi-AI/Kordi/pull/705
[#708]: https://github.com/Kordi-AI/Kordi/pull/708
[#712]: https://github.com/Kordi-AI/Kordi/pull/712
[#714]: https://github.com/Kordi-AI/Kordi/pull/714
[#716]: https://github.com/Kordi-AI/Kordi/pull/716
[#719]: https://github.com/Kordi-AI/Kordi/pull/719
[#721]: https://github.com/Kordi-AI/Kordi/pull/721
[#724]: https://github.com/Kordi-AI/Kordi/pull/724
[#727]: https://github.com/Kordi-AI/Kordi/pull/727
[#728]: https://github.com/Kordi-AI/Kordi/pull/728
[#730]: https://github.com/Kordi-AI/Kordi/pull/730
[#731]: https://github.com/Kordi-AI/Kordi/pull/731
[#733]: https://github.com/Kordi-AI/Kordi/pull/733
[#736]: https://github.com/Kordi-AI/Kordi/pull/736
[#737]: https://github.com/Kordi-AI/Kordi/pull/737
[#739]: https://github.com/Kordi-AI/Kordi/pull/739
[#740]: https://github.com/Kordi-AI/Kordi/pull/740
[#741]: https://github.com/Kordi-AI/Kordi/pull/741
[#693]: https://github.com/Kordi-Lab/Kordi/issues/693
[#751]: https://github.com/Kordi-Lab/Kordi/pull/751
[#752]: https://github.com/Kordi-Lab/Kordi/pull/752
[#753]: https://github.com/Kordi-Lab/Kordi/pull/753
[#754]: https://github.com/Kordi-Lab/Kordi/pull/754
[#755]: https://github.com/Kordi-Lab/Kordi/pull/755
[#757]: https://github.com/Kordi-Lab/Kordi/pull/757
[#759]: https://github.com/Kordi-Lab/Kordi/pull/759
[#840]: https://github.com/Kordi-Lab/Kordi/pull/840
[#853]: https://github.com/Kordi-Lab/Kordi/pull/853
[#856]: https://github.com/Kordi-Lab/Kordi/pull/856
[#858]: https://github.com/Kordi-Lab/Kordi/pull/858
[#859]: https://github.com/Kordi-Lab/Kordi/pull/859
[#863]: https://github.com/Kordi-Lab/Kordi/pull/863
[#864]: https://github.com/Kordi-Lab/Kordi/pull/864
[#866]: https://github.com/Kordi-Lab/Kordi/pull/866
[#868]: https://github.com/Kordi-Lab/Kordi/pull/868
[#869]: https://github.com/Kordi-Lab/Kordi/pull/869
[#870]: https://github.com/Kordi-Lab/Kordi/pull/870
[#873]: https://github.com/Kordi-Lab/Kordi/pull/873
[#875]: https://github.com/Kordi-Lab/Kordi/pull/875
[#879]: https://github.com/Kordi-Lab/Kordi/pull/879
[#880]: https://github.com/Kordi-Lab/Kordi/pull/880
[#882]: https://github.com/Kordi-Lab/Kordi/pull/882
[#883]: https://github.com/Kordi-Lab/Kordi/pull/883
[#884]: https://github.com/Kordi-Lab/Kordi/pull/884
[#889]: https://github.com/Kordi-Lab/Kordi/pull/889
[#890]: https://github.com/Kordi-Lab/Kordi/pull/890
[#891]: https://github.com/Kordi-Lab/Kordi/pull/891
[#894]: https://github.com/Kordi-Lab/Kordi/pull/894
[#896]: https://github.com/Kordi-Lab/Kordi/pull/896
[#901]: https://github.com/Kordi-Lab/Kordi/pull/901
[#903]: https://github.com/Kordi-Lab/Kordi/pull/903
[#920]: https://github.com/Kordi-Lab/Kordi/pull/920
[#923]: https://github.com/Kordi-Lab/Kordi/pull/923
[#924]: https://github.com/Kordi-Lab/Kordi/pull/924
[#927]: https://github.com/Kordi-Lab/Kordi/pull/927
[#935]: https://github.com/Kordi-Lab/Kordi/pull/935
[#936]: https://github.com/Kordi-Lab/Kordi/pull/936
[#937]: https://github.com/Kordi-Lab/Kordi/pull/937
[#939]: https://github.com/Kordi-Lab/Kordi/pull/939
[#940]: https://github.com/Kordi-Lab/Kordi/pull/940
[#941]: https://github.com/Kordi-Lab/Kordi/pull/941
[#942]: https://github.com/Kordi-Lab/Kordi/pull/942
[#945]: https://github.com/Kordi-Lab/Kordi/pull/945
[#951]: https://github.com/Kordi-Lab/Kordi/pull/951
[#952]: https://github.com/Kordi-Lab/Kordi/pull/952
[#955]: https://github.com/Kordi-Lab/Kordi/pull/955
[#956]: https://github.com/Kordi-Lab/Kordi/pull/956
[#957]: https://github.com/Kordi-Lab/Kordi/pull/957
[#980]: https://github.com/Kordi-Lab/Kordi/pull/980
[#985]: https://github.com/Kordi-Lab/Kordi/pull/985
[#989]: https://github.com/Kordi-Lab/Kordi/pull/989
[#991]: https://github.com/Kordi-Lab/Kordi/pull/991
[#995]: https://github.com/Kordi-Lab/Kordi/pull/995
[#1010]: https://github.com/Kordi-Lab/Kordi/pull/1010
[#1012]: https://github.com/Kordi-Lab/Kordi/pull/1012
[#1013]: https://github.com/Kordi-Lab/Kordi/pull/1013
[#1014]: https://github.com/Kordi-Lab/Kordi/pull/1014
[#1015]: https://github.com/Kordi-Lab/Kordi/pull/1015
[#1016]: https://github.com/Kordi-Lab/Kordi/pull/1016
[#1017]: https://github.com/Kordi-Lab/Kordi/pull/1017
[#1018]: https://github.com/Kordi-Lab/Kordi/pull/1018
[#1021]: https://github.com/Kordi-Lab/Kordi/pull/1021
[#1025]: https://github.com/Kordi-Lab/Kordi/pull/1025
[#1028]: https://github.com/Kordi-Lab/Kordi/pull/1028
[#1029]: https://github.com/Kordi-Lab/Kordi/pull/1029
[#1032]: https://github.com/Kordi-Lab/Kordi/pull/1032
[#1033]: https://github.com/Kordi-Lab/Kordi/pull/1033
[#1034]: https://github.com/Kordi-Lab/Kordi/pull/1034
[#1036]: https://github.com/Kordi-Lab/Kordi/pull/1036
[#1038]: https://github.com/Kordi-Lab/Kordi/pull/1038
[#1041]: https://github.com/Kordi-Lab/Kordi/pull/1041
[#1043]: https://github.com/Kordi-Lab/Kordi/pull/1043
[#1044]: https://github.com/Kordi-Lab/Kordi/pull/1044
[#1045]: https://github.com/Kordi-Lab/Kordi/pull/1045
[#1050]: https://github.com/Kordi-Lab/Kordi/pull/1050
[#1051]: https://github.com/Kordi-Lab/Kordi/pull/1051
[#1057]: https://github.com/Kordi-Lab/Kordi/pull/1057
[#1060]: https://github.com/Kordi-Lab/Kordi/pull/1060
[#1068]: https://github.com/Kordi-Lab/Kordi/pull/1068
[#1074]: https://github.com/Kordi-Lab/Kordi/pull/1074
[#1075]: https://github.com/Kordi-Lab/Kordi/pull/1075
[#1076]: https://github.com/Kordi-Lab/Kordi/pull/1076
[#1077]: https://github.com/Kordi-Lab/Kordi/pull/1077
[#1079]: https://github.com/Kordi-Lab/Kordi/pull/1079
[#1080]: https://github.com/Kordi-Lab/Kordi/pull/1080
[#1081]: https://github.com/Kordi-Lab/Kordi/pull/1081
[#1082]: https://github.com/Kordi-Lab/Kordi/pull/1082
[#1084]: https://github.com/Kordi-Lab/Kordi/pull/1084
[#1102]: https://github.com/Kordi-Lab/Kordi/issues/1102
[#1179]: https://github.com/Kordi-Lab/Kordi/issues/1179
[#1181]: https://github.com/Kordi-Lab/Kordi/pull/1181
[#1212]: https://github.com/Kordi-Lab/Kordi/pull/1212
[#1213]: https://github.com/Kordi-Lab/Kordi/pull/1213
[#1215]: https://github.com/Kordi-Lab/Kordi/pull/1215
[#1216]: https://github.com/Kordi-Lab/Kordi/pull/1216
[#1217]: https://github.com/Kordi-Lab/Kordi/pull/1217
[#1219]: https://github.com/Kordi-Lab/Kordi/pull/1219
[#1220]: https://github.com/Kordi-Lab/Kordi/pull/1220
[#1221]: https://github.com/Kordi-Lab/Kordi/pull/1221
[#1224]: https://github.com/Kordi-Lab/Kordi/pull/1224
[#1226]: https://github.com/Kordi-Lab/Kordi/pull/1226
[#1228]: https://github.com/Kordi-Lab/Kordi/pull/1228
[#1230]: https://github.com/Kordi-Lab/Kordi/pull/1230
[#1231]: https://github.com/Kordi-Lab/Kordi/pull/1231
[#1235]: https://github.com/Kordi-Lab/Kordi/pull/1235
[#1236]: https://github.com/Kordi-Lab/Kordi/pull/1236
[#1237]: https://github.com/Kordi-Lab/Kordi/pull/1237
[#1239]: https://github.com/Kordi-Lab/Kordi/pull/1239
[#1240]: https://github.com/Kordi-Lab/Kordi/pull/1240
[#1241]: https://github.com/Kordi-Lab/Kordi/pull/1241
[#1243]: https://github.com/Kordi-Lab/Kordi/pull/1243
[#1244]: https://github.com/Kordi-Lab/Kordi/pull/1244
[#1245]: https://github.com/Kordi-Lab/Kordi/pull/1245
[#1251]: https://github.com/Kordi-Lab/Kordi/pull/1251
[#1254]: https://github.com/Kordi-Lab/Kordi/pull/1254
[#1255]: https://github.com/Kordi-Lab/Kordi/pull/1255
[#1256]: https://github.com/Kordi-Lab/Kordi/pull/1256
[#1258]: https://github.com/Kordi-Lab/Kordi/pull/1258
[#1272]: https://github.com/Kordi-Lab/Kordi/pull/1272
[#1273]: https://github.com/Kordi-Lab/Kordi/pull/1273
[#1275]: https://github.com/Kordi-Lab/Kordi/pull/1275
[#1276]: https://github.com/Kordi-Lab/Kordi/pull/1276
[#1278]: https://github.com/Kordi-Lab/Kordi/pull/1278
[#1280]: https://github.com/Kordi-Lab/Kordi/pull/1280
[#1283]: https://github.com/Kordi-Lab/Kordi/pull/1283
[#1284]: https://github.com/Kordi-Lab/Kordi/pull/1284
[#1286]: https://github.com/Kordi-Lab/Kordi/pull/1286
[#1287]: https://github.com/Kordi-Lab/Kordi/pull/1287
[#1288]: https://github.com/Kordi-Lab/Kordi/pull/1288
[#1289]: https://github.com/Kordi-Lab/Kordi/pull/1289
[#1290]: https://github.com/Kordi-Lab/Kordi/pull/1290
[#1292]: https://github.com/Kordi-Lab/Kordi/pull/1292
[#1297]: https://github.com/Kordi-Lab/Kordi/pull/1297
[#1298]: https://github.com/Kordi-Lab/Kordi/pull/1298
[#1300]: https://github.com/Kordi-Lab/Kordi/pull/1300
[#1301]: https://github.com/Kordi-Lab/Kordi/pull/1301
[#1306]: https://github.com/Kordi-Lab/Kordi/pull/1306
[#1307]: https://github.com/Kordi-Lab/Kordi/pull/1307
[#1309]: https://github.com/Kordi-Lab/Kordi/pull/1309
[#1310]: https://github.com/Kordi-Lab/Kordi/pull/1310
[#1312]: https://github.com/Kordi-Lab/Kordi/pull/1312
[#1315]: https://github.com/Kordi-Lab/Kordi/pull/1315
[#1318]: https://github.com/Kordi-Lab/Kordi/pull/1318
[#1321]: https://github.com/Kordi-Lab/Kordi/pull/1321
[#1323]: https://github.com/Kordi-Lab/Kordi/pull/1323
[#1324]: https://github.com/Kordi-Lab/Kordi/pull/1324
[#1329]: https://github.com/Kordi-Lab/Kordi/pull/1329
[#1338]: https://github.com/Kordi-Lab/Kordi/pull/1338
[#1340]: https://github.com/Kordi-Lab/Kordi/pull/1340
[#1341]: https://github.com/Kordi-Lab/Kordi/pull/1341
[#1344]: https://github.com/Kordi-Lab/Kordi/pull/1344
[#1345]: https://github.com/Kordi-Lab/Kordi/pull/1345
[#1348]: https://github.com/Kordi-Lab/Kordi/pull/1348
[#1350]: https://github.com/Kordi-Lab/Kordi/pull/1350
[#1352]: https://github.com/Kordi-Lab/Kordi/pull/1352
[#1354]: https://github.com/Kordi-Lab/Kordi/pull/1354
[#1355]: https://github.com/Kordi-Lab/Kordi/pull/1355
[#1358]: https://github.com/Kordi-Lab/Kordi/pull/1358
[#1363]: https://github.com/Kordi-Lab/Kordi/pull/1363
[#1365]: https://github.com/Kordi-Lab/Kordi/issues/1365
[#1372]: https://github.com/Kordi-Lab/Kordi/pull/1372

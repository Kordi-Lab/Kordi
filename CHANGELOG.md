# Changelog

This file records notable user-facing changes to Kordi Desktop.

## [Unreleased]

## [0.0.1-beta.10] - 2026-07-31

### Changed

- Moved the canonical desktop, Cloud API, OAuth, and updater origin to
  `https://kordi.ai`. Existing installations that still poll
  `https://coordinar.io` retain a verified compatibility path to the same
  immutable release artifacts, so they can install beta.10 and migrate to the
  new origin safely. ([#753], [#840])
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

[Unreleased]: https://github.com/Kordi-Lab/Kordi/compare/V0.0.1.beta10...HEAD
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

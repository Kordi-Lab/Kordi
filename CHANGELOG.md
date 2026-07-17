# Changelog

This file records notable user-facing changes to Kordi Desktop.

## [Unreleased]

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

[Unreleased]: https://github.com/Kordi-AI/Kordi/compare/V0.0.1.beta8...HEAD
[0.0.1-beta.8]: https://github.com/Kordi-AI/Kordi/compare/V0.0.1.beta7...V0.0.1.beta8
[0.0.1-beta.7]: https://github.com/Kordi-AI/Kordi/releases/tag/V0.0.1.beta7
[beta.7 release notes]: https://github.com/Kordi-AI/Kordi/releases/tag/V0.0.1.beta7
[#700]: https://github.com/Kordi-AI/Kordi/pull/700
[#703]: https://github.com/Kordi-AI/Kordi/pull/703
[#704]: https://github.com/Kordi-AI/Kordi/pull/704
[#705]: https://github.com/Kordi-AI/Kordi/pull/705

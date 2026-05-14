# Cloud Post-Login Starting State Design

## Feature Summary
Cloud Edition should not enter the main desktop shell immediately after login. After authentication succeeds, the app should show a minimal animated starting screen while the first local canonical state and Cloud sync passes settle. The screen must be quiet, compact, and consistent in both light and dark themes.

## Primary User Action
The user does not act during the normal state. They should understand that Kordi is starting without reading explanatory copy.

## Design Direction
Use a small flat watercolor-style three-dot loader in Kordi's Cloud theme colors. Do not show the Kordi logo, a central circle, a spinner, or verbose text. The dots should gently float in sequence with low-amplitude motion. Respect `prefers-reduced-motion` by leaving the dots static.

## Layout Strategy
Use the existing Cloud gate shell and login background language. Center the dot loader on the page. Keep the loader visually lightweight and avoid cards, panels, or large text blocks.

## Key States
- Signed out: existing Cloud login page.
- Stored session restoring: existing gate-time loading state, updated to the same dot loader.
- Post-login syncing: show the dot loader while initial canonical + Cloud sync readiness has not settled.
- Ready with sessions: transition to the main app after initial sync settles.
- Ready with empty sessions: still show the dot loader briefly, then enter the main app once initial sync settles.
- Error/timeout: minimal retry state with no technical details unless needed for accessibility.

## Interaction Model
Normal startup is passive. If initial sync fails or times out, provide a small retry action that reruns the initial canonical/Cloud refresh path.

## Content Requirements
Normal loading state has no visible copy. Accessibility text should announce that Kordi is starting. Error state may show concise copy: “Couldn’t start Kordi” and “Try again”.

## Technical Design
Add a Cloud initial sync readiness signal from `useKordiAppModel`. The app shell hook can mount and run existing sync effects, but `KordiAppShell` should render the Cloud starting screen instead of `AppShellFrame` until readiness is true.

Readiness is true when:
- canonical state has completed its first fetch attempt and has a local profile identity when available; and
- Cloud contacts have completed their first fetch attempt or were skipped because there is no account; and
- Cloud bridge messages have completed their first fetch attempt or were skipped because there are no peers.

An empty session list is valid. It should not block readiness after sync attempts settle.

## Testing Requirements
- Unit-test the readiness helper for pending, ready, empty-session ready, and timeout/error cases.
- Render-test Cloud root/shell behavior: authenticated Cloud with pending initial sync shows the dot loader; ready state renders the app shell.
- CSS test verifies three watercolor dots and reduced-motion support.

## Open Questions
None. The user approved the flat three-dot watercolor loader direction and confirmed empty sessions should still show startup briefly but finish faster.

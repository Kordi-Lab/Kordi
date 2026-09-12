# SwiftUI accessibility layout reproduction

This standalone app has no Kordi or third-party dependencies. It renders mixed,
tall messages with native SwiftUI stacks and moves between rows with
`ScrollViewReader`. Its automatic scenario scrolls, toggles an overlay, and opens
the keyboard four times. Completion changes the heading to `Probe complete`.

The UI test repeatedly queries that heading, activating accessibility inspection.
Samples from failing runs show the main thread repeatedly updating SwiftUI lazy
layout through `GraphHost.flushTransactions`, AttributeGraph, and
`LazySubviewPlacements`. This occurs with native stacks and unique row IDs,
without Kordi's custom bubble layout or UIKit scroll bridge.

## Observed controls

| Target | Scenario | Result |
| --- | --- | --- |
| iOS 26.0 simulator | This reproduction under UI automation | Main-thread layout hang |
| iOS 26.0 simulator | Direct launch without accessibility inspection | Scenario completed |
| iOS 26.5 simulator | This reproduction under UI automation, three runs | Three main-thread layout hangs |
| iOS 27.0 simulator | This reproduction under UI automation | Passed |
| iOS 26.0 simulator | Replace only the outer `LazyVStack` with `VStack` | Passed |

Simplifying each row to a single accessibility label did not prevent the iOS 26.0
hang. Removing lazy layout did. These controls isolate a framework layout /
accessibility interaction; they do not establish Apple's internal defect or
prove every production hang has the same cause.

## Kordi regression comparison

- The earlier main-branch baseline (`fa7ef49c8`), with only synthetic fixtures and a UI test added,
  also hung on iOS 26.0 after repeated image menus. This predates the per-photo
  menu changes. Ordinary history scrolling followed by the keyboard passed on
  both main and the PR branch.
- The PR's mixed-history photo-menu regression on iOS 26.5 returned from both
  menus, but opening the keyboard left an empty timeline. Two runs failed, and
  a captured screenshot confirms this is visible content loss, not only an
  accessibility-query failure. These runs are not counted as hangs or passes.
- Optimized physical iOS 27 validation with Beta 21 passed the strengthened
  repeated-photo-menu and keyboard regression. The related 74 unit and hosted
  viewport tests also passed on the PR branch.
- Replacing Kordi's outer `LazyVStack` with `VStack` passed that iOS 26.5 regression
  three times. This remains a diagnostic control, not a retained runtime fix:
  history starts with 64 messages and grows as earlier pages are loaded, so an
  eager stack removes offscreen view eviction and can increase memory and
  rendering work. A compatibility implementation must preserve that behavior.

The iOS 26 release blocker remains open. Passing iOS 27 tests and reproducing the
issue on main do not establish that iOS 26 is safe. No experimental runtime
workaround from this investigation is included in the PR or installed Beta 21.

## Integration with the newer main branch

The PR was subsequently rebased onto `1705ca0fb` (#1503), preserving its native
reading-anchor restoration, initial-layout readiness, keyboard coordination,
and canonical message-deletion recovery. The native scroll bridge retains both
those hooks and the menu's temporary pan-gesture lock.

The iOS 26.5 mixed-history regression still failed after this integration: one
iteration lost the photo after opening the keyboard, and the next stalled during
scrolling after menu dismissal. The bounded runner stopped that process; its
sample again contained the SwiftUI transaction/lazy-placement loop. The newer
main changes therefore do not clear this release blocker.

The extended iOS 26.0 run passed 121 of 122 cases. The remaining case was
`testVisibleAIReplyClearsUnreadWithoutReachingExactBottom`, whose unread count
remained nonzero. The extended iOS 27.0 run also passed 121 of 122 cases; its
failure was `testRapidSendStartsAtItsFinalVisiblePosition`, which did not observe
the new bubble. These distinct results remain recorded rather than being
reported as a clean suite. A subsequent isolated iOS 27 rapid-send run passed
three of three repetitions; that retry does not erase the full-suite failure.

The iOS 27.0 UI regression passed all six executions: two runs each of grouped
photo reactions/deletion, long-message quick/expanded reactions, and repeated
photo menus followed by keyboard opening.

Production-channel Kordi 0.0.2 build 22 was built from the integrated runtime,
installed in place on a physical iPhone running iOS 27, and launched without
preview arguments. The app and share extension retained their signed app-group
and Keychain capabilities. This is a direct device test installation, not a
TestFlight release. No production server was changed; attachment-scoped mutations
still require the PR's server migration and endpoints before backend validation.

## Running the reproduction

Generate and run the project from this directory:

```sh
xcodegen generate
xcodebuild -project AccessibilityReproduction.xcodeproj -scheme Reproduction \
  -destination 'platform=iOS Simulator,id=<SIMULATOR_UDID>' \
  -derivedDataPath .build -parallel-testing-enabled NO test
```

For the control run, launch `ReproductionApp` directly from Xcode without running
the UI test, then wait for the completion heading. The app also writes synthetic
phase markers to its Documents directory. Do not publish unredacted device logs.

A [separate accessibility/lazy-stack reproduction](https://github.com/pendo-io/SwiftUI_Hang_Reproduction)
reports a related framework issue with a different, nested-lazy layout. That
report does not establish that all affected layouts share the same cause or
workaround; changes still need validation in the actual conversation screen.

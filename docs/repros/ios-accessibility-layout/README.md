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

- The main-branch baseline, with only synthetic fixtures and a UI test added,
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

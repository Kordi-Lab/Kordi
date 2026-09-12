# SwiftUI accessibility layout reproduction

This standalone app has no Kordi or third-party dependencies. It renders mixed,
tall messages with native SwiftUI stacks and moves between rows with
`ScrollViewReader`. Its automatic scenario scrolls, toggles an overlay, and opens
the keyboard four times. Completion changes the heading to `Probe complete`.

The UI test repeatedly queries that heading, activating accessibility inspection.
On the tested iOS 26.0 simulator, this can leave the main thread continuously
updating SwiftUI lazy layout. The same scenario can finish when launched directly
without inspection. The same test passed on the installed iOS 27.0 simulator.
This also occurs with the native stack and unique row IDs in
this reproduction, without Kordi's custom bubble layout or UIKit scroll bridge.

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

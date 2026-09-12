# SwiftUI accessibility layout reproduction

This directory preserves the unfixed framework control. Its iOS 26 accessibility
test is expected to reproduce the failure; Kordi's compatibility implementation
is verified by the app's regression targets rather than by changing this control.

## Applied compatibility implementation

`ConversationTimelineVirtualization.swift` selects an explicit viewport window on
iOS 26 and for nested Agent subsessions on every supported version. Ordinary
conversations on newer systems keep native `LazyVStack`. Lightweight row
slots retain measured heights and scroll identities. Message content is created
within the viewport plus one screen of overscan on either side, then released
when it leaves that window. A 64-point retention margin prevents repeated
mount/evict cycles from subpixel refinements at the boundary. The latest message, initial navigation target,
active menu/deletion source and staged sends remain available as needed.

The 200-row hosted test checks that fewer than 50 message bodies are mounted,
distant content is released, retained action sources survive scrolling, and a
measured tall row keeps its height after eviction. Placeholder slots have no
accessibility content; mounted messages retain their normal controls and labels.

Reading-anchor probes now request a coalesced capture when a row attaches or
finishes layout, even if the scroll offset has not changed. Departure bookkeeping
runs before teardown and can use the last displayed anchor after native views
detach; removed messages are still rejected. New tail rows follow one native content-bottom target before staged send
animations are revealed. Visible updates do not issue a second row-identity scroll.

The unread regression now approaches its target in bounded steps. Previously, a
jump computed from estimated content height could actually visit the bottom and
clear unread before the intended assertion. The test retains its offscreen
unread check and verifies clearance while still above the exact bottom.

Validation of the integrated fix:

- iOS 26.5: all 123 related XCTest cases passed.
- iOS 26.0: the same complete selection repeated twice, 246 executions passed.
- iOS 27.0: the same complete selection repeated twice, 246 executions passed.
- iOS 26.0 and iOS 26.5: ten menu scenarios repeated twice on each version,
  40 UI executions passed. These cover rendered long text, reactions, grouped
  photos, independent image/caption targets, voice holds, reply return, and the
  particle fade fallback.
- iOS 27.0: six menu/reaction UI executions passed.
- Physical iOS 27 with optimized offline Beta 23: six UI executions passed,
  covering grouped-photo actions, long-message reactions and menu/keyboard return.
- Repeated cached-entry and visible-reply checks passed three times each.
- The Markdown/parser class and container guard passed (70 XCTest cases and one
  Swift Testing case). The five gesture-registration cases also passed after
  updating legacy expectations: long presses cancel underlying control touches,
  while ordinary taps retain native forwarding.

## Completed Agent subsession entry

A subsequent customer report exposed a separate nested-navigation path on iOS 27.
The synthetic regression reproduced a blank completed task despite two loaded
messages. Initial positioning could be cancelled when GeometryReader replaced
its measurement subtree. After that lifecycle gap was corrected, a stale lazy
content-size estimate could still put the viewport below the actual last row.

Positioning now runs on the stable page, waits for preparation, geometry and
visibility independently, and requires the real last message to materialize.
Nested Agent subsessions use measured viewport row slots on every OS version.
The regression covers running and completed tasks, five entries into the same
completed task, and an interrupted entry followed by reopening. A dedicated UI
fixture verifies that the completed answer's end marker is actually hittable.
No task data or server behavior is changed by this fix.

### Cold-start scroll attachment

Read-only validation in the production client then reproduced a distinct failure
in one of three cold launches: the message row existed, but the scroll-position
bridge had no scroll view. Its single deferred lookup ran before SwiftUI inserted
the representable into the scroll hierarchy. The positioning deadline expired;
rendering the failure state caused another update that finally attached the
bridge, but the transcript remained hidden.

The bridge now resolves on native insertion, window attachment and layout, and
reconnects if its enclosing scroll view changes. It coalesces callbacks and avoids
reattaching observers during unchanged layout. Initial positioning waits for a
connected scroll view with usable bounds. History errors and positioning errors
have distinct recovery messages. Opt-in debug accessibility diagnostics expose
only counts, dimensions and attachment flags, never message text or identifiers.

Synthetic regressions cover cold network loading, a response arriving after the
navigation transition, very long content, late native insertion, zero-size initial
bounds and reparenting. The production reproduction uses existing authorized
content only; no production payload is copied into a fixture or this repository.

## Incoming replies and the visible bottom

Incoming group replies could lose bottom following as a placeholder grew, or move
twice: a row-identity scroll aligned the bubble edge, then native positioning
aligned the padded content edge. Depending on callback order, the later command
could undo the correct position by the trailing sentinel and padding height.

Incoming updates and staged sends now share the native content-bottom target.
A native resize observer captures whether the reader was at latest before the
content extent changes, coalesces layout corrections, and follows in either size
direction. User scrolling, a later programmatic move into history, inactive pages and
message-removal transitions cancel or suspend correction. Short bottom-aligned content keeps its native origin
behavior instead of receiving an extra correction.

The latest button also checks whether the last message's bottom is inside the
actual conversation viewport. Seeing half a long reply remains sufficient for
the existing read-visibility policy, but does not imply its bottom is visible.
The composer area is excluded from the bottom-visibility check.

The hosted regression inserts a quoted Agent placeholder in mixed-height group
history, streams progressively longer replies, then replaces them with a shorter
completion while the keyboard stays open. It checks frame-by-frame bottom spacing,
actual native tail position, and absence of a redundant latest button. A separate
history-reading case verifies that the same updates do not pull the reader away.

## Original framework control

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

At this stage the iOS 26 release blocker remained open. Passing iOS 27 tests and
reproducing the issue on main did not clear it. Beta 21 contained none of the
experimental runtime workarounds.

## Integration with the newer main branch

The PR was subsequently rebased onto `1705ca0fb` (#1503), preserving its native
reading-anchor restoration, initial-layout readiness, keyboard coordination,
and canonical message-deletion recovery. The native scroll bridge retains both
those hooks and the menu's temporary pan-gesture lock.

The iOS 26.5 mixed-history regression still failed after this integration: one
iteration lost the photo after opening the keyboard, and the next stalled during
scrolling after menu dismissal. The bounded runner stopped that process; its
sample again contained the SwiftUI transaction/lazy-placement loop. The newer
main changes alone therefore did not clear the release blocker.

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

# iOS trajectory layout fixtures

These captures come from hosted SwiftUI tests with in-memory synthetic messages
and the isolated Beta scheme. They contain no account or production content.

- `opening-details.png`: the clipped reveal keeps details below the header.
- `expanded-position.png`: expanding preserves the tapped header's position;
  details below the viewport remain available by scrolling.
- `short-chat-entry.png`: the fourth entry into a short conversation keeps the
  latest reply immediately above the composer.

The source tests are `AgentTrajectoryLayoutTests`. Captures were reviewed on an
iOS 27 simulator, including their metadata.

## Intermediate-frame regression

`TrajectoryExpansionUITests.testBriefConversationExpansionRecording` exercises
two brief turns with three expand/collapse cycles. Final accessibility frames
alone can miss a temporary displacement that settles before the tap returns.

Record this test with `simctl recordVideo` on a task-owned 3x iPhone simulator,
using the `Kordi Keyboard UI` scheme and default light theme. Then run:

```sh
python3 scripts/check-ios-trajectory-motion.py synthetic-recording.mov
```

The check tracks both outgoing bubbles in rendered video frames. It permits
six pixels (two points), including compression rounding, and fails if their
positions drift beyond that. Keep all recordings and raw test logs local.

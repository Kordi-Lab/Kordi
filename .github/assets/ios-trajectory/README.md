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

# Safe Desktop Mention Handles Design

## Goal

Desktop bridge mention handles must be safe to insert, render, and parse while still routing to the exact participant the user selected.

## Design

Autocomplete and message routing will use a shared bridge mention candidate builder. The builder creates a safe base handle from each participant display label by keeping only Unicode letters and numbers and limiting the result to 64 characters.

When two candidates produce the same safe handle, the builder appends a stable identity suffix derived from `humanId`, `agentId`, or `nodeId`. This makes handles unique within the active bridge state and prevents autocomplete from showing ambiguous duplicate labels that resolve to the wrong peer.

`resolveMentionedBridgeTarget()` will consume the same candidates as autocomplete. It will match safe unique handles first. For compatibility, it may also match a legacy display label only when exactly one target matches that display label.

Outreach identity will keep using the human-readable display label, while message mention metadata stores the safe handle.

## Testing

Add focused TypeScript tests for sanitization, unicode support, collision suffixes, shared autocomplete/resolver handles, display-label preservation, and unambiguous legacy matching. Final verification must run the focused mention tests, typecheck, and lint.

# Desktop Baseline Contract Reconciliation Design

## Summary

Four desktop unit-test assertions describe behavior that was intentionally superseded by later production changes. This repair updates those exact assertions while preserving strict coverage and leaving production code unchanged.

## Evidence

### Companion transcript sizing

`ChatsPage` changed the companion transcript from `h-full` to `min-h-0 flex-1` in commit `eb1413ddf` while adding side-panel model controls. The companion pane is a bounded flex column, so `flex-1` is the current contract: the transcript consumes the remaining height without competing with the header or composer. The viewport-containment test still expects the prior `h-full` class.

### Shared Cloud Agent detail labels

Commit `568a4d959` deliberately restored owner-scoped labels for shared Cloud Agents. The shared candidate contract and its focused test expect values such as `Shuyang's Agent`; one bridge-projection assertion still expects the older generic `Agent` label. The projection correctly forwards the owner-scoped detail.

### Group participant avatars

Commit `57027c5a5` deliberately added `avatarKey` and `profileImageUrl` to group update participants so participant avatars survive Cloud synchronization. Focused chat-create tests already enforce this shape. Two helper expectations still omit the added fields even though their fixtures contain avatar keys.

## Approved Design

Update only the four stale assertions:

1. Expect the companion transcript's exact `min-h-0 flex-1` containment classes.
2. Expect the shared hosted Cloud Agent detail to be `111's Agent`.
3. Expect both group session-sync participants to carry their fixture avatar key and a null profile-image URL.
4. Expect both group invite participants to carry the same avatar fields.

The tests remain exact. No assertion is removed, generalized, skipped, or converted to a snapshot. No production behavior changes.

## Verification

Run the three previously failing test files together and confirm all 27 tests pass. Then run the complete desktop unit suite before continuing with the Cloud replay-loop implementation.

## Acceptance Criteria

- All four previously failing assertions pass.
- The assertions encode the current intentional layout, identity-label, and avatar contracts.
- No production source is changed by this reconciliation.
- The complete desktop unit suite is green before replay-loop implementation begins.

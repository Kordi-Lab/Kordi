# Desktop Full-Suite Repair Design

## Summary

After reconciling the first four stale assertions, the complete desktop unit suite runs 1,198 tests and exposes 15 additional failures. They reduce to two production robustness bugs and two stale test contracts. This repair fixes the production bugs, updates only the superseded assertions, and keeps all coverage strict.

## Root Causes

### Preference storage detection

Node 25 can expose `globalThis.localStorage` as a truthy object without the `Storage` methods when `--localstorage-file` has no valid path. `avatarPreference` and `loginModePreference` currently accept any truthy candidate and immediately call `getItem`, causing one avatar-preference failure and eleven Cloud login rendering failures.

The same unchecked assumption can fail in restricted browser contexts where accessing or invoking Web Storage throws. Preference access should treat missing, structurally invalid, or inaccessible storage as unavailable.

### LM Studio passkey repair detection

`lmStudioNeedsInstallRefresh` lowercases the message and then compares it with the mixed-case text `rejected the lms CLI passkey`. That branch can never match. Consequently, the user-facing repair message produced by `lmStudioDisplayError` is not itself recognized as an invalid-passkey condition.

### Participant-space presence shape

Commit `ac333fed` intentionally added `presenceStatus` to participant-space avatars so Cloud presence can render in chat rows. One older participant-space assertion still omits the field.

### Project Cloud task visibility

Commits beginning with `d723960e` intentionally hydrate canonical Cloud task activity into the right task rail. One older project-panel test still expects delegated activity to be hidden, conflicting with the current task dashboard and its newer focused tests.

## Approved Design

### 1. Safe preference storage

Add one small Cloud preference-storage helper that:

- resolves an explicitly supplied storage object or `globalThis.localStorage`;
- catches access errors;
- verifies `getItem`, `setItem`, and `removeItem` are callable;
- returns `null` for missing or unusable storage.

Use it from both avatar and login-mode preferences. Read and clear operations will also catch storage invocation errors. Existing valid-storage behavior, keys, payload formats, and persistence semantics remain unchanged.

### 2. LM Studio matcher

Compare the normalized message with the fully lowercase needle `rejected the lms cli passkey`. Keep the existing repair copy and other detection branches unchanged.

### 3. Exact current contracts

- Expect the inferred participant-space avatar to include `presenceStatus: null`.
- Rename the project task-panel regression to describe visible synced Cloud activity, and assert the task row, agent name, current summary, request ID, and participant-avatar region are rendered. Continue asserting that obsolete `Delegated by` copy is absent.

## Testing

Use the existing failures as RED evidence. Add an explicit unusable-storage regression so correctness does not depend on the Node runtime's global shape. Run the five affected test files together, then the complete 1,198-test desktop suite.

## Non-goals

- Changing Cloud login layout or copy.
- Removing Web Storage persistence.
- Changing LM Studio repair actions or filesystem behavior.
- Removing presence from participant rows.
- Hiding canonical Cloud tasks from the task dashboard.
- Changing any replay-loop behavior in this repair batch.

## Acceptance Criteria

- Missing, malformed, or inaccessible preference storage does not throw.
- Valid preference storage continues to round-trip avatar and login-mode values.
- LM Studio repair guidance remains detectable as an invalid-passkey error.
- Participant-space avatars retain their presence field.
- Project sessions render canonical Cloud task activity.
- All desktop unit tests pass before replay-loop implementation resumes.

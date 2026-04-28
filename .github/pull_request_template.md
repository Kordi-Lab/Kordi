## Summary

<!-- What changed, and why? Keep this focused on the linked issue. -->

## Linked issue

Closes #<!-- issue number -->

## Type of change

- [ ] Bug fix
- [ ] Feature
- [ ] UX / design polish
- [ ] Infra / CI / tooling
- [ ] Docs
- [ ] Refactor / internal cleanup

## Project board

- Status before merge: <!-- In Review / Testing -->
- Tier: <!-- T0 / T1 / T2 / T3 -->
- Area: <!-- Desktop / Chat / Agents / Projects / Collaboration / Models / Remote / Infra / Design -->

## Implementation notes

<!-- Important architecture decisions, data model changes, affected files, or follow-up constraints. -->

## Screenshots / recordings

<!-- Required for visible UI changes. Drag images here or say N/A. -->

## Validation

<!-- Check everything that applies and include exact commands. -->

- [ ] `pnpm --dir app/desktop typecheck`
- [ ] `pnpm --dir app/desktop lint`
- [ ] `pnpm --dir app/desktop build`
- [ ] `cargo fmt --all -- --check`
- [ ] `cargo clippy --workspace --all-targets -- -A clippy::never_loop`
- [ ] `cargo test -p kordi-session`
- [ ] `cargo test -p kordi-cli --lib`
- [ ] `cargo test -p kordi-cli desktop_runtime --no-default-features`
- [ ] `cargo test -p kordi-desktop --no-default-features`
- [ ] `git diff --check`
- [ ] Manual QA performed

Manual QA notes:

```text

```

## Risk / rollback

<!-- What could go wrong? How can we safely revert or disable this? -->

## Follow-ups

<!-- List known follow-up issues or TODOs that should not block this PR. -->

- [ ] None

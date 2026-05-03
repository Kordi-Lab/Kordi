# Kordi app message type split

## Goal

Reduce `app/desktop/src/kordi-app/types.ts` below the 1,000-line maintainability scan threshold by moving message/transcript-adjacent type definitions into a focused child module, without changing runtime behavior or existing root imports.

## Scope

- Add a module-boundary regression test for `app/desktop/src/kordi-app/types/message.ts` and root barrel re-export wiring.
- Move message, transcript artifact, queued message, tool snapshot, and live-turn snapshot types to `app/desktop/src/kordi-app/types/message.ts`.
- Keep `app/desktop/src/kordi-app/types.ts` as the compatibility barrel for existing call sites.
- Update maintainability documentation with the completed split.

## Verification

- Red: targeted boundary test fails while `types/message.ts` is absent.
- Green: targeted boundary test passes after extraction.
- `pnpm --dir app/desktop typecheck`
- `pnpm --dir app/desktop lint`
- `pnpm --dir app/desktop exec tsx --test tests/kordiAppTypesBoundary.test.tsx`
- `pnpm maintainability:scan -- --min-lines 1000 --limit 25`
- `git diff --check`

# Artifact Preview Density Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make artifact Markdown previews denser/cooler and make the expanded preview window opaque.

**Architecture:** Keep the change scoped to `ArtifactInspector` and artifact-preview rendering. Do not change chat transcript Markdown. Add a focused test that asserts artifact preview uses compact density classes and opaque modal surfaces.

**Tech Stack:** React, Tailwind utility classes, Node `tsx --test` tests.

---

### Task 1: Dense neutral artifact preview styling

**Files:**
- Modify: `app/desktop/src/pages/ArtifactInspector.tsx`
- Test: `app/desktop/tests/artifacts.test.tsx`

- [ ] **Step 1: Write failing tests**

Add tests in `artifacts.test.tsx` checking:
- Markdown artifact preview includes `app-artifact-markdown-preview`.
- Preview window no longer uses translucent backdrop/blur classes and uses an opaque surface class.

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --dir app/desktop exec tsx --test tests/artifacts.test.tsx`
Expected: FAIL because the new classes are absent.

- [ ] **Step 3: Implement minimal styling changes**

In `ArtifactInspector.tsx`:
- Add compact neutral wrapper classes to markdown previews.
- Use cooler `app-code-panel`/panel backgrounds instead of transcript warmth.
- Make preview window overlay/content opaque; remove backdrop blur and translucent panel feel.

- [ ] **Step 4: Run targeted tests and typecheck**

Run:
```bash
pnpm --dir app/desktop exec tsx --test tests/artifacts.test.tsx
pnpm --dir app/desktop typecheck
```
Expected: both pass.

- [ ] **Step 5: Commit and push**

```bash
git add app/desktop/src/pages/ArtifactInspector.tsx app/desktop/tests/artifacts.test.tsx docs/superpowers/plans/2026-06-26-artifact-preview-density.md
git commit -m "fix: tighten artifact preview density"
git push
```

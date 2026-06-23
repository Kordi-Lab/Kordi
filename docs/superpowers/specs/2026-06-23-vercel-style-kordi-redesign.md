# Vercel-style Kordi redesign spec

Status: approved design direction for the next implementation pass

## Goal

Make Kordi feel obviously redesigned while following the Vercel DESIGN.md principles: restraint, neutral discipline, contextual accents, crisp hierarchy, shadow-as-border depth, and stable preview states.

The previous pass created a semantic token/depth foundation. This pass must make the product visibly different on the main daily surfaces, not merely cleaner under the hood.

## Design target

Kordi should feel like a precise, premium communication tool for technical work:

- dense and fast, closer to a chat client than a dashboard,
- white/graphite neutral chrome,
- high-confidence hierarchy,
- thin borders and disciplined shadows,
- contextual color only for state, identity, and action,
- no decorative glow, gradient text, or glass haze as the primary design language.

## Visual direction

### Light theme

- Canvas and app chrome should be white / near-white, not beige and not blue-tinted everywhere.
- Use hairline neutral borders to separate rail, sidebar, main transcript, composer, and right rail.
- Replace most translucent white-glass panels with opaque or near-opaque Vercel-style surfaces.
- Active navigation should be visually decisive: black/near-black active mark, or a very restrained accent where semantic.
- Chat rows should feel flatter and cleaner, with stronger selected-row contrast and quieter metadata.
- Composer should read as a premium input dock: white surface, crisp border, subtle shadow, clear focus ring.
- Self messages may use dark ink or a tightly controlled identity surface; avoid muddy warm beige chrome.

### Dark theme

- Use graphite/black neutral surfaces, not saturated navy/purple glass.
- Reduce glow and blur stacks materially.
- Floating surfaces should be crisp dark panels with thin borders and restrained depth.
- Selected rows and active controls should be clear without neon halos.
- Text levels should be semantic and readable: primary, secondary, muted, meta.
- Status colors should be low-chroma but legible.

## Main visible surfaces in scope

This pass should visibly affect:

1. App shell and window chrome
2. Left navigation rail
3. Workspace/sidebar session list
4. Chat transcript canvas
5. Chat bubbles and metadata hierarchy where needed for cohesion
6. Composer and model/action controls
7. Right detail rail and tasks/artifacts tabs
8. Floating surfaces used on the main path: mention menu, model menu, profile/menu popovers, create chat dialog
9. Settings/agents/contacts enough to stop them from looking like separate mini-themes

## Component rules

### Surfaces

Use a clear Vercel-like depth ladder:

- Level 0: canvas, no border/shadow
- Level 1: structural panels, hairline border only
- Level 2: cards/selected rows, border plus very small shadow
- Level 3: popovers/menus, crisp border plus compact shadow
- Level 4: modals/dialogs, stronger but still neutral depth

Structural panels should not use decorative radial glows or stacked glass shadows.

### Color

- Neutral surfaces dominate.
- Color is reserved for:
  - focus rings,
  - unread badges,
  - destructive actions,
  - running/success/warning/error status,
  - message identity when it improves scanability.
- Avoid broad page-specific color atmospheres.
- Avoid gray text directly on saturated colored backgrounds.

### Typography

- Stronger title/body/meta hierarchy.
- Dense lists should use smaller type confidently, but with clearer weight and contrast.
- Metadata should be quieter but not washed out.
- Labels and chips should feel like product UI, not dashboard badges.

### Concrete geometry and type scale

These values are the target contract for this pass, inspired by Vercel's precision and restraint:

- Global app font: system sans; no decorative display font.
- Main body copy: `13px` / `20px` line-height.
- Dense list rows: `12px` title/meta, `18px` line-height.
- Section labels: `10px`, uppercase, `0.12em` letter spacing.
- Conversation/page titles: `15px`–`17px`, `600` weight, `22px` line-height.
- Nav rail width: `56px`–`64px`; icon buttons `36px` square.
- Sidebar session rows: compact `44px` minimum for normal rows, `52px` when two-line preview is present.
- Structural gutters: `8px` between rail/sidebar/main/right rail; internal panel padding `12px`–`16px`.
- Composer shell: `min-height: 92px`, radius `18px`, padding `10px 12px`; textarea text `13px` / `20px`.
- Control buttons/chips: height `28px`–`32px`, radius `8px`–`10px`, horizontal padding `8px`–`12px`.
- Popovers/menus: radius `14px`, padding `6px`, item height `30px`–`34px`.
- Primary radius scale: `8px` controls, `12px` rows/cards, `16px` panels, `18px` composer, `20px` modal shells.
- Border width: `1px` hairlines only; no thick decorative outlines.
- Light structural border: neutral black alpha around `0.10`–`0.14`.
- Dark structural border: neutral white/slate alpha around `0.12`–`0.18`.
- Depth 1: border only, no visible shadow.
- Depth 2: one hairline plus `0 1px 2px` or similarly tiny shadow.
- Depth 3: compact popover shadow, not a large glow.
- Depth 4: modal shadow, still neutral and smaller than previous glass stacks.

### Motion and effects

- No gradient text.
- No decorative ambient glow for structural UI.
- Blur only where it improves layering; prefer opaque surfaces.
- Motion should be subtle and reduced-motion-safe.

## URL/native preview requirement

Native preview must open directly into an obvious review state where possible. The preview state should include:

- `?kordi-preview=1&theme=light&view=chats&detail=tasks`
- matching dark preview URL
- agents preview
- contacts preview
- settings preview

If Cloud login blocks shell preview in native mode, document that sign-in is required and keep browser/dev URLs available for visual QA.

## Implementation approach

This should be a broad but controlled visual pass, not a one-file token tweak.

Recommended order:

1. Strengthen token values toward white/graphite Vercel-style contrast.
2. Convert shell/sidebar/composer/right rail to visibly flatter bordered surfaces.
3. Normalize selected rows, buttons, chips, badges, and running states.
4. Apply the same surface discipline to floating menus/popovers.
5. Clean up agents/contacts/settings enough that they feel part of the same product.
6. Run visual scanner and targeted tests.
7. Open a native preview instance and document exactly what changed.

## Acceptance criteria

- A reviewer can immediately see the app changed, especially in light mode.
- The result still feels restrained and Vercel-inspired, not flashy.
- Shell/sidebar/composer/right rail look like one coherent product.
- Dark mode is intentionally tuned, not merely preserved.
- `npx impeccable detect app/desktop/src` reports no findings.
- `pnpm --dir app/desktop typecheck` passes.
- Focused UI/theme tests pass.
- Full suite status is documented, including any unrelated pre-existing failures.

## Non-goals

- Do not turn Kordi into a marketing page.
- Do not add neon, large gradients, or dashboard cards for visual impact.
- Do not remove dense communication-first layout.
- Do not rewrite routing.
- Do not chase every hard-coded utility in the repo if it does not affect the visible reviewed surfaces.

## Self-review

- No placeholders or TBDs remain.
- The visual target is explicit: Vercel-style neutral discipline, not generic polish.
- Scope is broad enough to be visibly redesigned but constrained to main UI surfaces.
- Native preview limitations are acknowledged.

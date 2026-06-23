# Dual-theme UI review and optimization plan

Issue: [#590](https://github.com/Kordi-AI/Kordi/issues/590)  
Date: 2026-06-22  
Status: review + implementation plan for both light and dark themes, no broad visual refactor yet

## Executive summary

Kordi needs both themes optimized as first-class product surfaces. Light mode has the most obvious cohesion problem, but dark mode should not be treated as “already done” or merely preserved. The app currently mixes:

- a warm paper/ink light-mode base in `theme-tokens.css` (`rgb(31 27 25)`, `rgba(43, 35, 32, *)`, warm tan shadows),
- cool slate/blue light-mode page-specific overrides in `theme-overrides.css` (`rgb(15 23 42)`, `rgb(148 163 184)`, `rgba(37, 99, 235, *)`),
- a dark-mode base that is more coherent but still depends on translucent glass, white-alpha dividers, saturated glow accents, and locally defined component colors,
- many dark-mode-first Tailwind utilities patched back with global `.theme-light` overrides (`text-white`, `text-slate-*`, `bg-white/*`, `border-white/*`), and
- multiple elevation styles that make panels look busier than a dense communication app should in either theme.

The plan should therefore be token- and route-first, not a page-by-page repaint. Kordi should keep its fast, technical, low-noise identity, with chat as the primary product shape. Use Vercel's DESIGN.md as a reference for restraint across both themes: neutral discipline, contextual accents, shadow-as-border depth, typography role hierarchy, and reproducible URL preview states.

## Review scope

Inspected source areas:

- Global tokens and overrides:
  - `app/desktop/src/styles/theme-tokens.css`
  - `app/desktop/src/styles/theme-overrides.css`
  - `app/desktop/src/styles/shell.css`
  - `app/desktop/src/styles/shell-pages.css`
  - `app/desktop/src/styles/shell-sidebar.css`
  - `app/desktop/src/styles/shell-transcript.css`
  - `app/desktop/src/styles/shell-bubbles.css`
  - `app/desktop/src/styles/shell-popovers.css`
- Shell and routing/state:
  - `app/desktop/src/KordiApp.tsx`
  - `app/desktop/src/app/AppShellFrame.tsx`
  - `app/desktop/src/app/useKordiAppModel.ts`
  - `app/desktop/src/app/useKordiLocalUiState.ts`
  - `app/desktop/src/app/useWorkspaceController.ts`
  - `app/desktop/src/app/MainContentSwitch.tsx`
- Major pages and reusable surfaces:
  - `WorkspaceSidebar.tsx`, `ChatsPage.tsx`, `RightDetailRail.tsx`, `TaskActivityDashboardPanel.tsx`
  - `SettingsPage.tsx`, `CloudAccountSettingsDialog.tsx`
  - `pages.tsx` contacts implementation
  - `agents/*`
  - `auth/*`
  - `ArtifactInspector.tsx`
  - transcript/composer primitives under `kordi-app/components/*`

Automated evidence:

- `npx impeccable --json --fast app/desktop/src/pages app/desktop/src/kordi-app app/desktop/src/features/cloud` found 4 gray-on-color warnings.
- A source scan across styles/pages/kordi-app/cloud found:
  - `text-slate-*`: 552 matches in 43 files
  - `bg-white/*`: 220 matches in 31 files
  - `border-white/*`: 237 matches in 36 files
  - hard hex colors: 102 matches in 11 files
  - raw `rgb()` / `rgba()`: 704 matches in 25 files
  - backdrop/filter usage: 93 matches in 21 files
  - shadow utilities: 146 matches in 37 files

These counts do not mean every instance is wrong. They show why dual-theme changes are hard to reason about: color and depth decisions are distributed across JSX, CSS tokens, dark defaults, light overrides, and component-specific patches.

## Current visual diagnosis

### What works

- The product direction is strong: dense chat, fast navigation, technical detail surfaces, and compact affordances suit Kordi better than a marketing-dashboard aesthetic.
- Dark mode has a more coherent base than light mode and tolerates translucent glass better, but it still needs active optimization for contrast, saturation, panel depth, and consistency.
- The recent right-detail-rail seam fix moved in the right direction: fewer visible panel seams, more reliance on a flat inspector rail.
- The transcript has a clear communication-first center: bubbles, live-turn cards, tool timelines, pins, quotes, and attachments are structurally rich.
- Design-specific CSS class names already exist (`app-composer-shell`, `app-agent-shell`, `app-surface-muted`, `app-inspector-tabs`, etc.), so the project can move away from raw utility colors without a full component rewrite.

### Main problem

The theme system needs a shared semantic contract, then theme-specific tuning.

Light mode is trying to be both:

1. **warm paper:** `rgb(31 27 25)`, `rgba(43, 35, 32, *)`, tan shadows, golden user bubble, and warm input focus; and
2. **cool cloud app:** slate blue text, blue selected states, blue auth panels, cool composer gradients, cool agent surfaces.

Dark mode is more visually unified, but it still has risks:

1. **white-alpha everything:** many dividers, fills, cards, and chips use `rgba(255,255,255,*)`, which can flatten hierarchy and create fuzzy seams;
2. **glass/glow accumulation:** dark translucency and blur look good locally, but too many layers make the app feel heavier and less communication-first;
3. **accent saturation drift:** cyan, purple, emerald, amber, rose, pink, and blue all appear as local component accents, so status/action/identity meanings can blur; and
4. **contrast inconsistency:** low-opacity muted text works in some panels but becomes too quiet inside cards, tool timelines, code previews, and popovers.

Both themes need the same role-based system. The most visible symptom is not one bad color; it is inconsistent interaction between neutral surfaces, accents, depth, and text hierarchy.

## Surface-by-surface findings

### 1. Global shell

Files: `AppShellFrame.tsx`, `theme-tokens.css`, `theme-overrides.css`, `shell.css`

Findings:

- `theme-light` base uses warm foreground/control/divider tokens but page backgrounds contain multiple cool/pink/yellow radial accents.
- `AppShellFrame` still uses dark-mode-style utility separators (`border-white/10`, `bg-white/8`, `bg-white/20`) that are corrected by broad overrides.
- Light mode applies shadows to major panels (`app-left-glass`, `app-session-panel`, `app-main-panel`) with multi-layer highlights. These make sidebars/main/rails compete instead of receding.
- Vercel reference suggests a stricter shell: neutral canvas, quiet rings, one contextual accent only when an action/state needs it.

Plan direction:

- Define explicit depth tokens and map shell panels to depth levels instead of ad hoc shadow stacks.
- For native full-window app, main structural panels should mostly be flat with 1px dividers, not card-like shadows.
- In dark mode, reduce repeated glow/glass depth so panels feel crisp rather than foggy.

### 2. Workspace sidebar and session rail

File: `WorkspaceSidebar.tsx`, `shell-sidebar.css`

Findings:

- The sidebar is the most communication-app-specific surface and should be the source of visual identity.
- It currently combines tokenized sidebar roles (`--app-sidebar-title-text`, `--app-sidebar-preview-text`, `--app-sidebar-selected-bg`) with raw utility color classes and nav accent classes.
- Active navigation/session states use a blue selected background (`#EEF4FF`) while nearby list items and shell controls are warm-neutral.
- Status badges and unread chips work functionally, but color hierarchy needs stronger rules: unread/presence/sync should not all feel like decorative accents.

Plan direction:

- Keep sidebar dense and WeChat-like: rows should be mostly flat, selected state should be subtle, unread should be the strongest color.
- Use only sidebar semantic tokens for title/preview/time/selected/unread/presence.
- Treat blue as an action/sync/link accent, not the default selected-row paint unless the final palette chooses cool-neutral as the app base.

### 3. Chat transcript and composer

Files: `ChatsPage.tsx`, `kordi-app/components/transcript.tsx`, `shell-transcript.css`, `shell-bubbles.css`, `composer.tsx`

Findings:

- Chat is structurally rich and should remain the product center.
- User bubble is warm gold (`oklch(... 82)`), peer bubble is cool slate (`oklch(... 240)`). This is an intentional contrast, but in light mode it intensifies the warm/cool split across the whole app.
- Composer light-mode override is strongly cool-blue (`rgba(37, 99, 235, *)`, blue-tinted gradient), while general controls/input tokens are warm. The composer is always visible, so this mismatch is prominent.
- Live turns/tool timelines contain many local color rules; the automated scan only found 4 anti-patterns, but the broader issue is too many accent families.

Plan direction:

- Decide whether chat bubbles define the accent system or are an exception. Recommended: bubbles are contextual message identity accents; the surrounding chrome stays neutral.
- Composer should be a calm input surface. Use neutral depth/ring tokens; reserve blue for focus ring or send action only.
- Normalize live/tool colors into semantic status tokens: `running`, `done`, `warning`, `error`, `info`, with carefully tuned light and dark variants.

### 4. Right detail rail, tasks, artifacts, source preview

Files: `RightDetailRail.tsx`, `TaskActivityDashboardPanel.tsx`, `ArtifactInspector.tsx`

Findings:

- Right rail improved after issue #576, but internals still include dark utility colors like `text-white`, `text-slate-*`, `border-white/10` and code/tool-specific raw colors.
- Artifact previews correctly need white/neutral document backgrounds for HTML/image/table content; these should be isolated as content-preview tokens rather than leaking into app chrome.
- Code panels and diff rows are high-risk in both themes because syntax/code backgrounds, line numbers, and add/remove states require high contrast without visual noise.

Plan direction:

- Treat right rail as an inspector, not a card stack: mostly flat background, subtle tabs, low-contrast section dividers.
- Introduce artifact/code preview tokens separate from app chrome tokens.
- Make task status and artifact states use the same status-token scale as transcript live/tool states.

### 5. Contacts

File: `kordi-app/pages.tsx`

Findings:

- Contacts page is still heavily dark-mode utility styled (`text-white`, `text-slate-*`, `border-white/10`) and relies on theme overrides.
- Information architecture is appropriate: request inbox, sent invites, contact groups, overlay detail. The visual hierarchy can be simplified.
- Contacts should feel like a messaging directory, not an admin dashboard.

Plan direction:

- Convert contact rows/request cards to list tokens shared with session/sidebar rows where possible.
- Use one attention treatment for pending requests; sent invites can be quiet status chips.
- Reduce rounded-card layering inside the page.

### 6. Agents

Files: `kordi-app/agents/*`, `theme-overrides.css`, `shell-pages.css`

Findings:

- Agents page is the clearest example of cool slate takeover. `theme-overrides.css` defines many agent-specific light rules using `rgb(248 250 252)`, `rgb(241 245 249)`, `rgb(148 163 184)`, `rgb(37 99 235)`, etc.
- The page has a dashboard-like three-pane structure. This is acceptable for agent configuration, but it should not reset the app's palette.
- Agent shells are relatively well-componentized, so this page can be normalized cleanly once tokens are established.

Plan direction:

- Keep the three-pane technical structure, but map it to global surface/depth/text tokens.
- Keep agent-specific accents only for ownership/status/skill selection, not for the whole panel background.
- Remove page-specific cool-neutral palette after global neutral decision.

### 7. Settings and account dialogs

Files: `SettingsPage.tsx`, `CloudAccountSettingsDialog.tsx`, `auth/*`

Findings:

- `SettingsPage.tsx` uses many dark utility classes; light mode is mostly achieved through global override patches.
- Auth/account surfaces are intentionally blue/cloud-like. This is understandable, but they currently conflict with the warm base and with chat's warm message identity.
- Dialog overlay and profile popover use glass treatments that can be attractive, but light mode has too much translucent layering.

Plan direction:

- Settings should be the baseline neutral discipline page: simple left rail, simple content list, minimal shadows.
- Auth provider statuses can use contextual color; panels should not all be blue-tinted.
- Cloud login can keep slightly more brand expression because it is a gate/landing-like screen, but post-login settings should match app chrome.

### 8. Popovers, dialogs, overlays

Files: `shell-popovers.css`, `CloudAccountSettingsDialog.tsx`, `ChatCreateDialog.tsx`, `MessageForwardDialog.tsx`, `SessionActionOverlays.tsx`

Findings:

- Popovers are mostly tokenized but light mode still uses translucent glass and custom shadow stacks.
- Multiple overlay styles compete: frosted popover, profile popover, account dialog, composer menu, mention menu.
- Vercel reference favors predictable floating surfaces with clear ring/shadow separation rather than glass for every layer.

Plan direction:

- Create a floating-surface contract: menu, popover, dialog, sheet, tooltip each has a defined background/ring/shadow.
- In light mode, prefer opaque/near-opaque white or neutral surfaces with thin border and small shadow. Use blur sparingly.
- In dark mode, prefer crisp dark surfaces with controlled borders and fewer stacked glows. Use blur only for overlays that truly need background separation.

## Dark-theme optimization checklist

Dark mode should be reviewed with the same seriousness as light mode. Specific dark-theme checks:

- **Contrast:** verify muted text, timestamps, disabled controls, code line numbers, tab labels, and popover secondary text against their actual surface backgrounds.
- **Depth:** reduce stacked blur/glow on shell panels, popovers, cards, live turns, and composer surfaces; prefer crisp borders plus restrained shadows.
- **Accent discipline:** reserve bright cyan/blue/purple/green/amber/rose for semantic states. Avoid decorative accents that compete with active chat, unread, running task, and error states.
- **White-alpha drift:** replace repeated `rgba(255,255,255,*)` fills/dividers with semantic tokens so dark surfaces have predictable hierarchy.
- **Code/artifact readability:** ensure code preview, diff additions/removals, markdown, table previews, and iframe/document previews do not feel either washed out or overly luminous.
- **Communication feel:** preserve dense chat-first readability. Dark mode should feel calm and fast, not like a glowing control room.

## URL-based preview/debug finding

Current app state is not URL-addressable:

- `useWorkspaceController` initializes active nav/session/project/detail state with React state only.
- `useKordiLocalUiState` owns contacts, agents, settings, composer, and theme UI state locally.
- `MainContentSwitch` switches by `activeNav`; no `URLSearchParams` or route mapping drives it.
- Runtime search-param usage is effectively absent outside tests and artifact data naming.

This makes UI review hard because a reviewer cannot share a stable URL for “light theme, agents page, Kordi agent selected, right rail artifacts open, side agent open” or the matching dark-theme state. It also encourages manual clicking and one-off screenshots.

Plan direction:

- Add a lightweight URL state layer for web/dev preview only, without breaking Tauri/native usage.
- Start with query params, not a full router:
  - `?theme=light|dark|auto`
  - `?nav=chats|contacts|agents|settings`
  - `?chat=<session-id>`
  - `?project=<project-id>&projectSession=<session-id>`
  - `?detail=info|tasks|artifacts|context`
  - `?settings=general|appearance|auth|...`
  - `?agent=<agent-id>`
  - `?contact=<contact-id>`
  - `?preview=ui-review-light|ui-review-dark|...`
- Add curated preview fixtures for common visual states, then document paired light/dark URLs in the plan/issue.

## Recommended palette direction

Choose one shared semantic palette model, then tune light and dark separately. Recommendation: **neutral-cool chrome with warm human-message accents**, because:

- Kordi is technical and communication-first; neutral-cool chrome better supports code, tool output, and dense metadata in both themes.
- Existing auth/agents/cloud surfaces already lean slate/blue, so aligning the base system reduces drift.
- Warm accents can remain meaningful for human/self message identity and warnings without making the whole app beige.
- Dark mode should stay crisp and technical, not become a high-glow glass dashboard.

Concrete light target:

- Base canvas: near-neutral cool paper (`oklch` with hue around 240 but very low chroma), not blue-tinted panels everywhere.
- Text: neutral ink with 3 semantic levels: title/body/muted/meta.
- Dividers: one family using alpha on ink, not mixed tan and slate.
- Accent: one primary action/link accent, likely blue/cyan but low chroma in surfaces.
- Message identity: human/self can keep warm gold; peer/agent can stay neutral or subtle cool.
- Status: separate semantic hues, low-chroma fills.

Concrete dark target:

- Base canvas: deep neutral graphite, not pure black and not saturated navy.
- Text: reduce reliance on opacity-only white; use semantic text levels that maintain contrast in panels, cards, and popovers.
- Dividers: crisp low-alpha borders that separate structure without creating bright seams.
- Accent: same primary/action/status semantics as light mode, but with lower glow and controlled chroma.
- Message identity: preserve readable bubble contrast without over-bright white bubbles or muddy peer bubbles.
- Depth: fewer blur/glow stacks; use shadow-as-border and subtle elevation differences.

If the team prefers warm paper instead, invert the light decision: convert agents/auth/composer/sidebar cool blue surfaces to warm-neutral and keep blue only for links/focus. Dark mode should still remain a neutral graphite system, not a warm brown-black theme. Do not keep multiple chrome palettes as equal peers.

## Implementation plan

### Phase 0 — Preview and audit foundation

Goal: make UI review reproducible before touching broad styles.

Tasks:

1. Add `useUrlPreviewState` or equivalent web/dev-only hook.
2. Hydrate initial UI state from URL params for `theme`, `nav`, `detail`, `settings`, `agent`, `contact`, and selected chat/project where possible.
3. Keep native/Tauri behavior safe: query params should initialize state but not force URL writes unless running in web preview.
4. Add curated preview fixtures/states in paired light and dark URLs:
   - chat with active thread, side agent panel, right tasks rail
   - contacts with pending request and add-contact form
   - agents with selected agent + file preview/editing state
   - settings/auth/account dialog
   - artifact/code preview rail
   - cloud login/start screen
5. Document paired preview URLs in `docs/design-previews` or `docs/superpowers/specs`.

Acceptance checks:

- Opening a preview URL lands on the expected surface without manual clicks.
- Theme can be forced via URL without changing stored preference unexpectedly.
- Existing native startup/login gate still works.

Suggested tests:

- unit tests for URL param normalization and state hydration
- render smoke tests for `KordiAppRoot`/`AppShellFrame` in paired light and dark preview states

### Phase 1 — Dual-theme token contract and neutral decision

Goal: stop one-off color drift in both themes.

Tasks:

1. Add explicit semantic token groups:
   - `--app-surface-canvas`
   - `--app-surface-shell`
   - `--app-surface-rail`
   - `--app-surface-panel`
   - `--app-surface-card`
   - `--app-surface-float`
   - `--app-text-primary`
   - `--app-text-secondary`
   - `--app-text-muted`
   - `--app-text-meta`
   - `--app-border-subtle`
   - `--app-border-strong`
   - `--app-ring-focus`
   - `--app-accent-primary-*`
   - `--app-status-*`
2. Define depth tokens:
   - depth 0: canvas/no border
   - depth 1: panel/rail with hairline border only
   - depth 2: raised card with ring + tiny shadow
   - depth 3: popover/menu
   - depth 4: modal/dialog
3. Update existing tokens (`--utility-*`, `--app-divider`, `--app-control-*`, `--app-shadow-*`) to alias the new semantic contract.
4. Remove or reduce multi-layer light-mode shadows on structural panels.
5. Reduce repeated dark-mode glow/glass stacks on structural panels.
6. Decide final neutral temperature for light chrome and final graphite baseline for dark chrome; encode both in `theme-tokens.css` comments.

Acceptance checks:

- One file communicates both theme systems clearly.
- No page-specific token block needs to choose a different neutral family.
- Focus rings are visible and consistent in light and dark themes.
- Both themes expose the same semantic roles even when their numeric values differ.

### Phase 2 — Shell, sidebar, transcript, composer normalization

Goal: optimize the surfaces users see all day in both themes.

Tasks:

1. Convert `AppShellFrame` separators from raw `border-white/*` / `bg-white/*` to semantic divider classes/tokens.
2. Normalize workspace/sidebar rows to semantic list tokens.
3. Normalize selected/session/unread/presence/sync states.
4. Simplify composer styling in both themes:
   - neutral input shell
   - focus ring from `--app-ring-focus`
   - send/action accent only where needed
   - dark-mode depth that is crisp, not overly glowing
5. Normalize chat bubbles only after the chrome decision:
   - keep warm self bubble if desired
   - ensure metadata contrast and mention/link accents are consistent
   - verify dark bubble contrast and muted metadata readability
6. Consolidate transcript live/tool status colors under status tokens with paired light/dark values.

Acceptance checks:

- Chat, sidebar, and composer look like one product in both themes.
- Unread, active, focus, and live-running states are visually distinct without multiple competing blues/yellows/glows.
- Right-resize and session dividers are subtle and consistent in light and dark themes.

### Phase 3 — Page/component cleanup

Goal: remove global override dependence and page-specific palette drift.

Tasks:

1. Replace dark-mode-first utilities in major pages with semantic classes/tokens:
   - `SettingsPage.tsx`
   - `kordi-app/pages.tsx` contacts
   - `kordi-app/agents/*`
   - `RightDetailRail.tsx`
   - `ArtifactInspector.tsx`
   - `CloudAccountSettingsDialog.tsx`
2. Reduce `.theme-light .text-white`, `.text-slate-*`, `.bg-white/*`, `.border-white/*` override surface area.
3. Replace dark-mode local white-alpha styling with semantic surface/text/divider classes where it affects hierarchy.
4. Convert agent-specific cool slate overrides to global surface tokens.
5. Convert settings/auth account panels to neutral surfaces with contextual provider/status accents.
6. Convert artifact/code panels to dedicated content-preview tokens for both themes.

Acceptance checks:

- The count of hard-coded `text-slate-*`, `bg-white/*`, and `border-white/*` occurrences in reviewed app files drops materially.
- Both themes pass contrast checks for metadata, line numbers, chips, code, disabled states, and popover content.
- Settings, agents, contacts, and chat feel related, not like separate mini-themes.

### Phase 4 — Floating surfaces and depth polish

Goal: make menus/dialogs predictable and quiet.

Tasks:

1. Create a floating surface matrix:
   - menu / compact model menu
   - mention menu
   - chat create popover
   - profile popover
   - account dialog
   - message forward dialog
   - detail sheets
2. Replace ad hoc glass/shadow with depth tokens.
3. Keep blur only where it adds real context separation; prefer near-opaque surfaces in light mode and crisp low-glow surfaces in dark mode.
4. Ensure z-index and portal roots stay stable.

Acceptance checks:

- Popovers are readable against all preview states.
- Shadow/ring treatment communicates depth without adding visual fog.
- Light and dark mode both feel first-class.

### Phase 5 — Regression, docs, and issue follow-up

Goal: prevent drift from returning.

Tasks:

1. Add lightweight CSS/token tests:
   - tokens exist for semantic roles
   - no broad page-specific cool/warm override blocks are reintroduced without naming a semantic role
   - preview URLs parse consistently
2. Add visual QA checklist to issue #590:
   - chat + side agent + right tasks
   - contacts requests
   - agents detail/file pane
   - settings/auth/account dialog
   - artifact/code preview
   - cloud login/start screen
3. Run typecheck/unit tests relevant to touched files.
4. Capture before/after screenshots or named preview URLs for each surface.
5. Update issue #590 with the final plan and phased PR breakdown.

## Suggested PR breakdown

1. **PR A: URL preview state + fixtures**
   - No visual style changes except what is necessary to expose states.
2. **PR B: semantic tokens + depth contract**
   - Token additions/aliases, minimal component changes.
3. **PR C: shell/sidebar/composer/transcript dual-theme pass**
   - Main daily-use surfaces in both themes.
4. **PR D: settings/contacts/agents cleanup**
   - Remove most dark utility override dependence and normalize dark-mode local white-alpha styling.
5. **PR E: right rail/artifacts/tasks/status colors**
   - Inspector and technical surfaces in both themes.
6. **PR F: popovers/dialogs/final polish + regression tests**
   - Floating surface system and documentation.

## Non-goals for the first implementation pass

- Do not redesign Kordi into a marketing dashboard.
- Do not remove density or technical detail.
- Do not rewrite routing with a heavy router unless query-param previews prove insufficient.
- Do not treat dark mode as complete by default; optimize it intentionally with explicit before/after checks.
- Do not chase every hard-coded color in one mega-PR. Prioritize shared surfaces and obvious drift.

## Definition of done

- Stable preview/debug URLs exist for the major review states.
- Light mode has one explicit neutral temperature for app chrome.
- Dark mode has one explicit graphite/deep-neutral baseline for app chrome.
- Structural panel depth uses documented depth tokens in both themes.
- Chat/sidebar/composer/right rail/settings/contacts/agents/account dialogs all use the same surface/text/divider system.
- Contextual color is reserved for state/action/identity, not decorative panel backgrounds.
- Global Tailwind utility overrides are smaller and no longer the main mechanism for theme correctness.

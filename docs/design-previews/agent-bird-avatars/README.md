# Agent bird avatars proposal

Static browser preview of a new default avatar for Cloud Agents: a paper-cut bird
portrait in the Kordi logo family instead of the DiceBear `thumbs` face. People
keep their Lorelei avatar. The page uses synthetic agents, loads nothing from the
network, and changes nothing outside the page.

Serve it from this directory, bound to loopback:

```sh
cd docs/design-previews/agent-bird-avatars
python3 -m http.server 8763 --bind 127.0.0.1
# open http://127.0.0.1:8763/
```

Query parameters (kept in sync with the controls): `tone=color|slate|ink`,
`bg=paper|tint`, `device=mac|ios`, `theme=light|dark`.

- Roster: 16 species, each a head-and-shoulders portrait facing right. Species are
  told apart by beak, crest and markings only; the bird itself stays ink, cream and
  grey, with amber for the beak and eye.
- Tone: `color` uses natural species colours with a soft vertical gradient and a
  specular dot in the eye, in the spirit of the Icons8 Fluency bird icons the owner
  likes; `slate` is a monochrome grey gradient; `ink` is the flat logo black. All three
  are offered in the picker (owner decision 2026-10-24); the page control only sets
  the roster default.
  The artwork is original. Icons8 files are not used: their free tier needs a visible
  link and the paid license bars redistributing the icons as a set, which a
  server-rendered roster is.
- Background: paper, or one of the eight app-icon tints so two agents with the same
  species still differ.
- Picker: choose a tone, a species and a colour, upload a photo, or shuffle. It
  replaces the dice button in the desktop agent inspector and the Factory blueprint.
  iOS only reads agent avatars today, so it gets the picker when an agent editor
  exists there.
- Existing seeds: random seeds already stored for agents hash to a stable bird, so no
  agent changes picture twice.

## Proposed contract

- Add the agent style `kordi-birds` beside `lorelei` and `thumbs`; keep the renderer
  version string. `thumbs` stays renderable so every immutable avatar URL keeps
  working. The bird artwork is in-repo SVG, so a later redraw ships as `kordi-birds-2`.
- Seeds: the picker writes `bird-<species>-<tone>-<palette>` (valid seed characters).
  Any other seed (existing random hex, `default-agent-<account>`, agent ids) maps to a
  species and palette through FNV-1a with tone `color`, on every platform, with the
  same table.
- The server keeps rendering 256 px PNGs through the existing routes, render cache,
  throttle and render-key allowlist; only `render_png` gains a branch that fills the
  species template instead of calling DiceBear.
- Mutations stay `upload`, `regenerate` (now with a chosen or shuffled structured seed)
  and `remove_upload`. Uploaded photos stay in front of the generated bird, as today.
- One generator script (`scripts/kordi-birds/`) is the source of truth for the geometry
  and emits the server templates, the desktop inline SVGs and the iOS assets, the same
  way `scripts/kordi-app-icons/` does for the app icon.

## Rollout order

Old desktop builds drop a Cloud Agent whose avatar style they do not know
(`normalizeCanonicalAvatarDescriptor` returns null in `cloudAgents.ts`), and old iOS
builds show a blank tile. So:

1. Desktop and iOS accept and render `kordi-birds` (read side only), then ship a desktop
   release and a TestFlight build.
2. Server: migration relaxes the `avatar_style` checks on `cloud_agent_definitions`,
   `cloud_default_agent_profiles` and `cloud_avatar_render_keys`, backfills generated
   agent avatars from `thumbs` to `kordi-birds` with `version + 1`, keeps the old render
   keys, and leaves uploaded avatars alone. New agents start as birds.
3. Picker on desktop, replacing the dice; iOS follows once it has an agent editor.

Files touched per step: `bridges/cloud-server/src/avatars.rs`, `avatars/rendering.rs`,
a new migration, `docs/avatar-system.md`; `app/desktop/src/features/cloud/canonicalAvatar.ts`,
`kordi-app/components/EditableIdentityAvatar.tsx`, `kordi-app/agents/model.ts`,
`kordi-app/agents/AgentStudioBlueprintView.tsx`; `app/ios/Kordi/Core/API/CloudModels.swift` and
`Features/Shared/IdentityAvatar.swift`; plus the tests that pin `thumbs` today.

# [Feature] Kordi Modular Watercolor Animal Avatars for Agents

> **Design reference:** attach `kordi-agent-avatar-concept.png` to this issue.
>
> **Working name:** Kordi Cut-Paper Animals

## Summary

Create an original, modular avatar system for every Kordi Agent. Each avatar is a small black-and-off-white animal rendered like a hand-cut paper sticker with charcoal ink edges. The animal itself always remains monochrome. Color appears only on wearable items such as clothing, hats, shoes, scarves, bags, and headphones, using the same soft watercolor language as the Kordi icon.

The system should feel as flexible as a paper-doll/avatar builder, but it must have a clearly original Kordi silhouette and must not copy Reddit Snoo, third-party emoji, or other character IP.

Every Agent receives a stable default avatar at creation and can later be customized. The same avatar manifest must render consistently on Mac, iPhone, Android, and Web, remain available offline after assets are cached, and synchronize through Kordi's normal durable sync system.

---

## Product Goals

1. Give every Agent a memorable, friendly identity.
2. Let users distinguish many Agents at a glance without relying only on names or colors.
3. Support a large number of combinations without drawing a completely separate character for every outfit.
4. Match Kordi's watercolor icon and soft paper-sticker brand language.
5. Make customization fast enough to use during Agent creation.
6. Keep the system deterministic, versioned, cacheable, and safe to synchronize across devices.
7. Create a foundation that can later support seasonal packs, creator packs, gestures, and animated states.

## Non-Goals for MVP

- No user-uploaded avatar parts.
- No marketplace, trading, rarity, NFT, or collectible mechanics.
- No fully freeform drawing editor.
- No body-color picker; animals must remain monochrome.
- No 3D models.
- No full-body skeletal animation.
- No direct copy of Reddit Snoo proportions, antenna, facial geometry, or item designs.

---

# 1. Visual Direction

## 1.1 Core Style: “Kordi Cut-Paper Watercolor”

The visual system combines three materials:

- **Animal:** black and warm off-white paper-cut shapes.
- **Linework:** slightly irregular charcoal or brush-ink outlines.
- **Wearables:** translucent watercolor washes with visible pigment pooling and gentle paper grain.

The result should look handmade, calm, playful, and premium rather than glossy, plastic, or overly cartoonish.

## 1.2 Non-Negotiable Visual Rules

### Animal body

- Use only warm off-white, ink black, and a small amount of neutral gray.
- No colored fur, skin, feathers, horns, ears, tails, cheeks, or eye highlights.
- Species identity comes from silhouette, ears, muzzle, markings, tail, and proportions.
- Facial features stay minimal: dot/oval eyes, one-stroke mouth, simple nose, and restrained eyebrows.

### Wearables

- Clothing, hats, shoes, scarves, bags, bows, headphones, and similar worn items may use color.
- Each item uses one dominant watercolor color and at most one supporting shade.
- Avoid highly saturated neon colors.
- Texture must be baked into the artwork rather than added as random runtime noise.

### Props

- Hand-held props are primarily monochrome ink drawings.
- A prop may use one very small accent that matches the selected clothing palette, but it must never become more colorful than the outfit.

### Background

- Default background is warm paper white.
- Optional backgrounds use a very pale watercolor wash outside the character silhouette.
- Background color must not make the animal itself appear colored.

### Sticker treatment

- Final avatar receives a warm white outer border around the combined silhouette.
- Add a very soft paper shadow, not a glossy UI drop shadow.
- Edges may be slightly imperfect, but the silhouette must remain clean at 32 px.

## 1.3 Things to Avoid

- Pure black `#000000` and pure white `#FFFFFF` as the primary art colors.
- Thick uniform vector outlines.
- Shiny gradients, 3D lighting, plastic rendering, or photorealistic fur.
- Anime eyes or highly detailed facial anatomy.
- More than two strong colors on one outfit.
- Colored animal bodies.
- Direct visual references to Snoo, Hello Kitty, LINE Friends, Sanrio, or existing emoji sets.

---

# 2. Color and Material System

## 2.1 Base Ink Colors

| Token | Suggested value | Usage |
|---|---:|---|
| `ink.primary` | `#1D1B1A` | Main black paper and linework |
| `ink.soft` | `#34302E` | Softer internal details |
| `paper.avatar` | `#FBF6EC` | Animal white areas and sticker border |
| `paper.shadow` | `#D7CEC0` | Soft paper shadow |
| `neutral.wash` | `#CFC8BE` | Optional light gray markings |

These are design tokens, not a requirement to flatten the watercolor texture into solid colors.

## 2.2 Curated Wearable Palettes

MVP should ship with eight controlled palettes:

| Palette ID | Description | Suggested anchor |
|---|---|---:|
| `palette.violet` | Kordi violet | `#7A67D1` |
| `palette.sky` | Calm blue | `#6392C8` |
| `palette.sage` | Soft green | `#749B78` |
| `palette.sun` | Warm yellow | `#D9AE3D` |
| `palette.coral` | Soft coral | `#D77B72` |
| `palette.orange` | Burnt orange | `#C98445` |
| `palette.denim` | Muted denim | `#57718D` |
| `palette.charcoal` | Neutral dark | `#3A3B3F` |

Each garment is authored in selected curated colorways. Do not expose a completely free RGB picker in MVP; curated colors keep the collection visually coherent and preserve watercolor quality.

---

# 3. Character Construction System

## 3.1 Shared Paper-Doll Frame

All species use one shared front-facing body frame so the same tops, bottoms, and shoes can fit every animal.

Species identity is mainly carried by:

- Head silhouette.
- Ear, horn, or antenna silhouette.
- Facial marking mask.
- Muzzle shape.
- Tail.
- Small paw/foot details.

This prevents the content workload from multiplying every clothing item by every species.

## 3.2 Default Pose

MVP uses one canonical pose:

- Front-facing.
- Head slightly larger than body.
- Arms relaxed near the torso.
- Feet separated enough for shoes to remain readable.
- Tail may appear behind or beside the body.
- Neutral center of gravity; no extreme pose.

Gestures such as waving, pointing, sitting, typing, or holding two-handed objects are Phase 2.

## 3.3 Master Canvas

- Authoring canvas: `1024 × 1024` transparent square.
- Character visual bounds: approximately `760 × 860` centered.
- Safe area: at least `72 px` from every edge.
- Common anchor origin: canvas center.
- All layers must export at identical canvas dimensions.

## 3.4 Required Anchors

Each species definition must provide normalized anchor positions:

- `head.center`
- `face.eyes`
- `face.mouth`
- `face.muzzle`
- `head.top`
- `ear.left`
- `ear.right`
- `neck.center`
- `shoulder.left`
- `shoulder.right`
- `hand.left`
- `hand.right`
- `hip.center`
- `foot.left`
- `foot.right`
- `tail.root`

These anchors allow shared expressions, glasses, headphones, hats, props, and other components to align across species.

## 3.5 Layer Order

Use a deterministic z-order for every platform:

| Z | Layer |
|---:|---|
| 0 | Background wash |
| 10 | Ground shadow |
| 20 | Rear tail / rear accessory |
| 30 | Shared body base |
| 40 | Species body markings |
| 50 | Bottom garment / one-piece lower section |
| 60 | Shoes |
| 70 | Top garment / one-piece upper section |
| 80 | Head base |
| 90 | Species head markings and muzzle |
| 100 | Expression overlay |
| 110 | Neck accessory |
| 120 | Face accessory |
| 130 | Front paws / arms |
| 140 | Hand-held prop |
| 150 | Headwear / headphones |
| 160 | Foreground decorative accent |
| 170 | Combined sticker outline and paper shadow |

The exact implementation may use grouped passes, but the visible result must be deterministic.

---

# 4. Avatar Slots

## 4.1 Required MVP Slots

| Slot | Required | Notes |
|---|---|---|
| `species` | Yes | Base animal |
| `marking` | Yes | Species-specific monochrome pattern |
| `expression` | Yes | Face state |
| `headwear` | No | Hat, bow, crown, headphones, etc. |
| `top` | No | Hoodie, jacket, sweater, shirt |
| `bottom` | No | Jeans, shorts, cargos, skirt |
| `onePiece` | No | Dress, overalls, robe; conflicts with top/bottom |
| `shoes` | No | Sneakers, boots, loafers |
| `faceAccessory` | No | Glasses, sunglasses, eye patch |
| `neckAccessory` | No | Scarf, bow tie, necklace, lanyard |
| `bagAccessory` | No | Cross-body bag or backpack |
| `prop` | No | Laptop, book, brush, controller, etc. |
| `background` | No | Pale watercolor wash |
| `palette` | Yes | Curated wearable color family |

## 4.2 Compatibility Rules

- `onePiece` disables `top` and `bottom`.
- Headwear declares one of four fit modes:
  - `over_ears`
  - `between_ears`
  - `behind_ears`
  - `replace_ear_region`
- Tall-ear species can use only compatible headwear unless a species-specific override exists.
- Headphones require left/right ear anchors.
- Glasses require eye and muzzle anchors.
- Bags may conflict with large back accessories.
- Props declare `left_hand`, `right_hand`, or `two_hand` attachment mode.
- MVP should avoid two-hand props because they require additional arm artwork.
- Hidden incompatible items must not appear selectable.

## 4.3 Changing Species

When a user changes the species:

1. Keep all compatible clothing and accessories.
2. Automatically replace only incompatible headwear/accessories with `none`.
3. Preserve palette, background, expression, and prop when possible.
4. Show a small non-blocking message explaining any removed item.

---

# 5. Animal Roster

## 5.1 MVP Species: 16 Animals

All species remain black and off-white, even when the real animal is normally colorful.

| ID | Animal | Distinguishing monochrome design |
|---|---|---|
| `species.panda` | Panda | Round ears, black eye patches, black arms/legs, tiny round tail |
| `species.cat_tuxedo` | Tuxedo cat | Triangle ears, black forehead/cheeks, white muzzle, curved tail |
| `species.rabbit` | Rabbit | Long upright ears, compact muzzle, round tail |
| `species.dog_floppy` | Floppy-ear puppy | One dark ear, optional eye patch, rounded muzzle |
| `species.bear` | Bear | Small round ears, broad cheeks, dark paws, short tail |
| `species.penguin` | Penguin | Black hood/back shape, white face and belly, small flippers |
| `species.fox` | Fox | Sharp ears, dark ear tips, white muzzle/chest, large pointed tail |
| `species.frog` | Frog | Raised round eyes, wide mouth, dark finger/toe marks |
| `species.otter` | Otter | Small ears, white muzzle/belly, long dark tail |
| `species.raccoon` | Raccoon | Dark eye mask, striped monochrome tail, pointed muzzle |
| `species.hamster` | Hamster | Round cheeks, tiny ears, dark side patches, very short tail |
| `species.tiger` | Tiger | White body with bold black stripes and rounded ears |
| `species.cow` | Cow | Irregular black patches, small horns, rounded muzzle |
| `species.sheep` | Sheep | Cloud-like off-white wool, dark face and feet |
| `species.hedgehog` | Hedgehog | Dark cut-paper quill silhouette around an off-white face |
| `species.deer` | Deer | Dark antlers, long ears, small muzzle, monochrome spot pattern |

## 5.2 Expansion Species

Phase 2 content can add:

- Duck.
- Pig.
- Squirrel.
- Capybara.
- Bat.
- Koala.
- Owl.
- Red panda interpreted in monochrome.
- Seal.
- Mouse.
- Goat.
- Axolotl interpreted as an abstract black-and-white paper creature.

## 5.3 Marking Variants

Species with recognizable patterns should receive two or three monochrome marking variants. Examples:

- Cat: tuxedo, mask, one-eye patch.
- Dog: one-ear patch, eye patch, both ears dark.
- Cow: small patches, large patches, asymmetrical face patch.
- Tiger: narrow stripes, broad stripes.
- Rabbit: dark ear tips, one dark ear, plain.
- Bear: plain, dark muzzle patch.

Markings must not change the species silhouette or introduce body color.

---

# 6. Expressions and Agent States

## 6.1 Expression Pack

MVP expressions:

1. Neutral.
2. Soft smile.
3. Big happy smile.
4. Focused.
5. Thinking.
6. Wink.
7. Surprised.
8. Sleepy.
9. Confused.
10. Worried.
11. Proud.
12. Calm/eyes closed.

Expressions must remain readable at `32 × 32` and avoid tiny detail.

## 6.2 Optional Runtime State Mapping

The saved avatar expression is the Agent's normal identity. Kordi may temporarily display a state expression without changing the saved manifest:

| Agent state | Temporary visual treatment |
|---|---|
| Queued | Neutral face with a subtle monochrome clock badge |
| Generating | Focused face with a gentle two-frame blink or head bob |
| Completed | Soft smile for a brief moment |
| Cancelled | Return to saved expression |
| Failed | Worried expression with a monochrome warning mark |
| Incomplete | Confused expression with a small ink ellipsis |

Status treatments must not rely on color alone.

---

# 7. MVP Content Pack

## 7.1 Species and Faces

- 16 species.
- 1–3 marking variants per species.
- 12 expressions.
- 1 canonical pose.

## 7.2 Headwear

At least 10 designs:

- Beanie.
- Baseball cap.
- Bucket hat.
- Beret.
- Hood.
- Bow.
- Flower crown.
- Small crown.
- Over-ear headphones.
- Ear-warming headband.

## 7.3 Tops

At least 12 designs:

- Pullover hoodie.
- Zip hoodie.
- Denim jacket.
- Bomber jacket.
- Cardigan.
- Varsity jacket.
- Crew-neck sweater.
- Striped shirt.
- T-shirt.
- Raincoat.
- Lab coat.
- Utility vest.

## 7.4 Bottoms

At least 8 designs:

- Straight jeans.
- Cuffed jeans.
- Cargo pants.
- Shorts.
- Soft trousers.
- Pleated skirt.
- Joggers.
- Patchwork pants.

## 7.5 One-Piece Items

At least 4 designs:

- Overalls.
- Simple dress.
- Apron outfit.
- Cozy robe.

## 7.6 Shoes

At least 6 designs:

- Low sneakers.
- High-top sneakers.
- Canvas shoes.
- Hiking boots.
- Rain boots.
- Loafers.

## 7.7 Wearable Accessories

At least 10 designs:

- Round glasses.
- Square glasses.
- Sunglasses.
- Scarf.
- Bow tie.
- Small necklace.
- Lanyard/badge.
- Cross-body bag.
- Backpack.
- Small cape.

## 7.8 Props

At least 8 mostly monochrome props:

- Laptop.
- Notebook/book.
- Paintbrush.
- Magnifying glass.
- Game controller.
- Microphone.
- Wrench/tool.
- Coffee cup.

## 7.9 Backgrounds

At least 8 options:

- None / paper white.
- Violet wash.
- Sky wash.
- Sage wash.
- Sun wash.
- Coral wash.
- Ink-night wash.
- Soft paper grid.

Every colored garment should launch in at least four curated palettes. High-visibility hero garments may launch in all eight palettes.

---

# 8. Avatar Presets

Kordi should provide ready-made presets so users can create an Agent quickly. Presets choose an outfit and prop but do not permanently tie a role to a species.

Suggested presets:

| Preset | Outfit | Prop |
|---|---|---|
| Coding | Hoodie or utility jacket | Laptop |
| Research | Cardigan or vest | Book or magnifying glass |
| Creative | Oversized sweater or apron | Paintbrush |
| Support | Zip hoodie | Headphones |
| Product | Denim jacket | Notebook |
| Data | Crew-neck sweater | Laptop |
| Writing | Cardigan | Book |
| General Assistant | Simple hoodie | None |

The user can apply a preset to any species.

---

# 9. Default Avatar Generation

Every newly created Agent receives a deterministic starter avatar.

## 9.1 Rules

- Generate from a stable seed based on `agent_id` and the current catalog version.
- Store the resulting manifest immediately; do not recalculate it every time the Agent loads.
- Avoid duplicate combinations within the current user's visible Agent list by re-rolling up to eight times.
- Use only compatible items.
- Never generate an outfit with more than two strong colors.
- Always include at least one colored wearable so the avatar is not visually empty.
- Do not assign species based on role, gender, nationality, or personality stereotype.

## 9.2 Randomize Controls

The editor should support:

- Randomize everything.
- Randomize animal only.
- Randomize outfit only.
- Randomize expression only.
- Lock individual slots before randomizing.

Randomization must be seeded so undo/redo remains predictable.

---

# 10. Editor UX

## 10.1 Entry Points

- Agent creation flow.
- Agent profile/settings page.
- Agent card context menu: `Edit appearance`.
- Optional prompt after creating the first Agent.

## 10.2 Mobile Layout

- Large avatar preview at the top.
- Horizontal category tabs below the preview.
- Scrollable item grid in a bottom sheet.
- Palette row appears after selecting a wearable item.
- Persistent actions:
  - Undo.
  - Redo.
  - Randomize.
  - Reset.
  - Save.

## 10.3 Desktop/Web Layout

- Left: large live preview.
- Center: vertical category navigation.
- Right: item grid and palette variants.
- Bottom or top-right: Save and Cancel.

## 10.4 Category Order

1. Animal.
2. Markings.
3. Expression.
4. Headwear.
5. Top.
6. Bottom.
7. One-piece.
8. Shoes.
9. Face accessory.
10. Neck accessory.
11. Bag.
12. Prop.
13. Background.

## 10.5 Interaction Details

- Selection updates the preview immediately without a server request.
- Selected item displays a clear check state.
- `None` is the first item in optional categories.
- Changing a garment exposes its curated color variants.
- Incompatible items are hidden rather than shown disabled.
- Undo/redo history is local until Save.
- Closing with unsaved changes opens a discard confirmation.
- Save uses optimistic UI and immediately updates local Agent surfaces.
- On save failure, retain the edited draft and offer Retry.

## 10.6 Tiny Avatar Crops

The editor creates one canonical full avatar, but the product needs three display crops:

- `full`: entire body for editor and profile.
- `bust`: head and upper torso for message headers.
- `head`: face-focused crop for compact lists and notifications.

Crop bounds are deterministic and included in the species metadata.

---

# 11. Asset Authoring and Export

## 11.1 Master Files

Maintain a source package with:

- Shared body frame.
- One component page per species.
- Expression components.
- Wearable components.
- Anchor overlays.
- Compatibility masks.
- Export naming guide.
- Automated contact-sheet page.

The master can be maintained in a layered design tool, but runtime exports must be deterministic and platform-neutral.

## 11.2 Runtime Asset Format

Recommended runtime approach:

- Transparent raster layers for watercolor assets.
- One identical `1024 × 1024` coordinate system for every layer.
- Lossless or high-quality alpha-capable assets.
- Immutable, content-hashed filenames.
- Separate `128 × 128` thumbnails for the picker.
- Final rendered avatar snapshots at `64`, `128`, `256`, and `512` px.

Do not depend on runtime filters to invent watercolor texture.

## 11.3 Naming Convention

Examples:

```text
species.panda.base.v1
species.cat_tuxedo.marking.mask.v1
expression.focused.v1
headwear.beanie.violet.v1
top.hoodie.sage.v1
bottom.cargo.denim.v1
shoes.hightop.coral.v1
prop.laptop.ink.v1
background.wash.violet.v1
```

IDs are stable and language-independent. Display names are localized separately.

## 11.4 Asset Manifest Fields

Each catalog item should include:

```ts
interface AvatarAsset {
  id: string;
  category: AvatarCategory;
  displayNameKey: string;
  version: number;
  zIndex: number;
  thumbnailUrl: string;
  sourceUrl: string;
  checksum: string;
  fitMode?: "universal" | "over_ears" | "between_ears" | "behind_ears" | "replace_ear_region";
  compatibleSpecies?: string[];
  incompatibleSpecies?: string[];
  attachmentAnchor?: string;
  paletteId?: string;
  tags: string[];
  status: "active" | "deprecated";
}
```

---

# 12. Avatar Data Model

## 12.1 Canonical Manifest

```json
{
  "schemaVersion": 1,
  "catalogVersion": 1,
  "avatarId": "avt_01KORDI...",
  "agentId": "agt_01KORDI...",
  "version": 7,
  "species": "species.cat_tuxedo",
  "marking": "species.cat_tuxedo.marking.mask",
  "pose": "pose.front",
  "expression": "expression.focused",
  "slots": {
    "headwear": "headwear.beanie.sage",
    "top": "top.utility_jacket.sage",
    "bottom": "bottom.jeans.denim",
    "onePiece": null,
    "shoes": "shoes.canvas.ink",
    "faceAccessory": null,
    "neckAccessory": null,
    "bagAccessory": null,
    "prop": "prop.laptop.ink"
  },
  "background": "background.wash.sage",
  "palette": "palette.sage",
  "source": "edited",
  "seed": "62f8d0...",
  "updatedAt": "2026-08-11T10:00:00Z"
}
```

## 12.2 Suggested Tables

### `agent_avatars`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID / sortable ID | Primary key |
| `agent_id` | UUID | Unique foreign key |
| `schema_version` | INT | Manifest schema |
| `catalog_version` | INT | Asset catalog used |
| `manifest` | JSONB | Canonical full manifest |
| `version` | BIGINT | Monotonic entity version |
| `created_by` | UUID | User/account ID |
| `created_at` | TIMESTAMPTZ | Creation time |
| `updated_at` | TIMESTAMPTZ | Last update |

### `avatar_assets`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT | Stable asset ID |
| `category` | TEXT | Slot/category |
| `version` | INT | Asset version |
| `z_index` | INT | Render order |
| `metadata` | JSONB | Anchors, compatibility, tags |
| `source_url` | TEXT | Immutable asset URL |
| `thumbnail_url` | TEXT | Picker thumbnail |
| `checksum` | TEXT | Integrity verification |
| `status` | TEXT | Active/deprecated |

### `avatar_catalog_versions`

Stores immutable catalog manifests and migration mappings.

### `avatar_renders`

Stores generated snapshots by avatar version, crop, and size.

## 12.3 Validation Rules

The server must:

- Accept only known asset IDs.
- Reject arbitrary external URLs.
- Validate slot/category matches.
- Validate compatibility.
- Validate mutually exclusive slots.
- Validate schema and catalog versions.
- Reject stale writes.
- Preserve old active assets referenced by existing avatars or provide a migration mapping.

---

# 13. API Design

Suggested endpoints:

```text
GET  /v1/avatar-catalog
GET  /v1/avatar-catalog/{version}
GET  /v1/agents/{agentId}/avatar
PUT  /v1/agents/{agentId}/avatar
POST /v1/agents/{agentId}/avatar/randomize
GET  /v1/avatars/{avatarId}/renders
```

## 13.1 Update Request

```json
{
  "idempotencyKey": "01KORDI...",
  "baseVersion": 6,
  "manifest": {
    "schemaVersion": 1,
    "catalogVersion": 1,
    "species": "species.panda",
    "marking": "species.panda.marking.default",
    "pose": "pose.front",
    "expression": "expression.happy",
    "slots": {
      "headwear": null,
      "top": "top.hoodie.violet",
      "bottom": "bottom.jeans.denim",
      "onePiece": null,
      "shoes": "shoes.canvas.ink",
      "faceAccessory": null,
      "neckAccessory": null,
      "bagAccessory": null,
      "prop": null
    },
    "background": "background.wash.violet",
    "palette": "palette.violet"
  }
}
```

## 13.2 Update Response

Return the full canonical snapshot, the new monotonic version, and render status.

```json
{
  "avatar": { "...": "full canonical manifest" },
  "version": 7,
  "renderStatus": "queued"
}
```

---

# 14. Sync and Offline Behavior

Kordi uses PostgreSQL as canonical server state and clients render from a local persistent database. Avatar state should follow the same rules as other synchronized entities.

## 14.1 Required Behavior

- Persist the canonical avatar manifest on the server.
- Cache the manifest and required assets locally.
- Render the UI from local state, not directly from WebSocket payloads.
- Save operations are idempotent.
- Avatar versions are monotonic.
- Stale updates are rejected.
- A durable sync event publishes the updated full snapshot or a reference to fetch it.
- Local avatar entity and sync cursor are committed atomically.
- WebSocket is transport/wakeup only; it is not the source of UI state.
- Offline edits are queued and retried when connectivity returns.

## 14.2 Conflict Handling

A save includes `baseVersion`.

- If the server version matches, accept the update.
- If the server is newer, return `409 avatar_version_conflict` with the current snapshot.
- If local and remote edits touched different slots, the client may automatically rebase the local slot changes.
- If the same slot changed on both devices, show a simple choice:
  - Keep changes from this device.
  - Use latest saved avatar.

## 14.3 Catalog Caching

- Catalog manifests are immutable by version.
- Assets use content-hashed URLs and long-lived cache headers.
- The client stores the last known valid catalog.
- Core assets should be available immediately after initial setup.
- Additional packs download lazily.
- A missing optional asset falls back to `none`; a missing species falls back to `species.panda` while preserving the original manifest for recovery.

---

# 15. Rendering Pipeline

## 15.1 Client Preview

The editor composes cached layers locally in real time.

Rendering steps:

1. Resolve the manifest against the local catalog.
2. Load layers in deterministic z-order.
3. Composite at the master coordinate system.
4. Generate a combined alpha mask.
5. Draw the warm sticker outline behind the combined silhouette.
6. Draw the paper shadow.
7. Downsample to the display size.
8. Cache by `avatarId + avatarVersion + crop + size`.

## 15.2 Server Render Worker

After save, enqueue a render job that creates trusted immutable snapshots:

- Full: 512, 256, 128, 64.
- Bust: 256, 128, 64.
- Head: 128, 64, 32.

Server snapshots are useful for notifications, email, shared links, and surfaces that cannot run the compositor.

The UI should not wait for the worker; it already has a client-rendered preview.

## 15.3 Fallback

If rendering fails:

- Keep the manifest saved.
- Continue showing the locally composed avatar.
- Retry the render job.
- Use the previous successful snapshot on remote surfaces until the new one is ready.

---

# 16. Permissions

MVP permissions:

- Agent owner can edit the avatar.
- Workspace members with Agent edit permission can edit it.
- View-only members cannot modify it.
- System Agents may have locked default avatars.
- Admin-created style packs are trusted catalog content.

Future personal overrides may let a user change how an Agent appears only to them, but that is outside MVP.

---

# 17. Accessibility

- Do not use color as the only signal for Agent state or role.
- Provide a generated text description, for example: “Black-and-white panda wearing a violet hoodie and canvas shoes.”
- Every picker item needs a localized accessible name.
- Selection state needs shape/icon and text, not only a colored border.
- Support reduced motion; blinking and bobbing animations become static.
- Maintain readable silhouette and facial contrast at 32 px.
- Avoid rapid flashing or continuous attention-seeking animation.

---

# 18. Performance Targets

These are product targets, not hard protocol limits:

- Cached editor opens without blocking on the network.
- First preview appears from local assets immediately.
- Changing one item should feel instant.
- Starter asset pack target: approximately `12 MB` or less after compression.
- Picker thumbnails load independently from full-resolution layers.
- Avoid decoding all full-resolution assets at editor open.
- Keep only the visible category and current selection in the hot cache.
- Cache final avatar snapshots aggressively by version.

---

# 19. Analytics

Track only product interaction events; do not record private prompt content.

Suggested events:

```text
avatar_editor_opened
avatar_category_viewed
avatar_asset_selected
avatar_palette_selected
avatar_randomized
avatar_undo
avatar_redo
avatar_saved
avatar_save_failed
avatar_render_failed
avatar_default_generated
```

Useful properties:

- Entry point.
- Agent type.
- Selected species ID.
- Number of edited slots.
- Time from editor open to save.
- Randomize used or not.
- Catalog version.

---

# 20. QA and Art Validation

## 20.1 Automated Validation

Build a tool that:

- Loads every asset manifest.
- Confirms source files exist.
- Confirms dimensions and alpha channel.
- Confirms checksums.
- Confirms allowed z-index range.
- Confirms all declared anchors exist.
- Rejects an asset assigned to the wrong category.
- Generates contact sheets for every species and item category.
- Detects obvious clipping outside the safe area.
- Renders representative combinations at 32, 64, 128, and 512 px.

## 20.2 Compatibility Matrix

Every headwear, top, bottom, shoe, face accessory, and neck accessory must be tested against all 16 MVP species or explicitly marked incompatible.

## 20.3 Visual Review Checklist

- Animal remains black/off-white.
- Only wearable layers carry significant color.
- Watercolor texture is visible but not noisy.
- Clothing does not cover eyes or mouth unintentionally.
- Ears, horns, and antlers do not clip through headwear unless designed that way.
- Shoes align with both feet.
- Props align with the correct paw.
- Sticker outline has no seams or holes.
- Character remains recognizable at 32 px.
- No asset resembles protected third-party character art.

---

# 21. Acceptance Criteria

The feature is complete when:

- [ ] Every newly created Agent receives a stable generated avatar.
- [ ] Users with permission can open the avatar editor from Agent creation and Agent settings.
- [ ] MVP includes 16 species and the defined starter clothing/accessory catalog.
- [ ] All animal bodies remain monochrome in every valid combination.
- [ ] Wearable items use curated watercolor colorways.
- [ ] Users can change species while retaining compatible clothing.
- [ ] Users can randomize all or selected categories.
- [ ] Undo, redo, reset, cancel, and save work correctly.
- [ ] The same manifest renders consistently on Mac, iPhone, Android, and Web.
- [ ] Saved changes synchronize across devices through the durable sync engine.
- [ ] Offline edits queue and synchronize later.
- [ ] Stale writes are rejected and conflict behavior is implemented.
- [ ] Avatar manifests reference only validated catalog assets.
- [ ] Tiny head crops are readable at 32 px.
- [ ] Server-generated snapshots are produced after save or a clear fallback is in place.
- [ ] Asset and render failures do not remove or corrupt the saved manifest.
- [ ] Accessibility labels and reduced-motion behavior are implemented.
- [ ] Automated contact sheets and compatibility checks run in CI or the asset build pipeline.

---

# 22. Implementation Plan

## Phase 0 — Style Lock

- [ ] Approve “Kordi Cut-Paper Watercolor” visual rules.
- [ ] Approve base ink and paper tokens.
- [ ] Approve the eight wearable palettes.
- [ ] Approve one universal body frame and master canvas.
- [ ] Produce final panda, cat, rabbit, dog, penguin, and fox samples.
- [ ] Verify readability at 32, 64, and 128 px.

## Phase 1 — Avatar Foundation

- [ ] Define avatar manifest schema.
- [ ] Create catalog schema and versioning.
- [ ] Implement local deterministic compositor.
- [ ] Implement combined sticker outline pass.
- [ ] Add local avatar cache.
- [ ] Build full/bust/head crop logic.
- [ ] Add default seeded avatar generation.

## Phase 2 — Editor

- [ ] Build mobile editor layout.
- [ ] Build desktop/web split layout.
- [ ] Add category browsing.
- [ ] Add palette variants.
- [ ] Add compatibility filtering.
- [ ] Add randomize and slot locks.
- [ ] Add undo/redo/reset.
- [ ] Add unsaved-change protection.

## Phase 3 — Backend and Sync

- [ ] Add avatar tables.
- [ ] Add catalog endpoints.
- [ ] Add get/update avatar endpoints.
- [ ] Add idempotency and base-version checks.
- [ ] Emit durable `agent.avatar.updated` sync event.
- [ ] Store avatar state in the client local database.
- [ ] Add offline mutation queue behavior.
- [ ] Add conflict response and rebase logic.

## Phase 4 — Rendering and Delivery

- [ ] Build render worker.
- [ ] Store immutable snapshots by version/crop/size.
- [ ] Add CDN/cache strategy for catalog assets and renders.
- [ ] Add render retry and previous-snapshot fallback.
- [ ] Integrate head/bust/full variants into all Kordi surfaces.

## Phase 5 — MVP Art Pack

- [ ] Complete 16 species.
- [ ] Complete marking variants.
- [ ] Complete 12 expressions.
- [ ] Complete 10 headwear items.
- [ ] Complete 12 tops.
- [ ] Complete 8 bottoms.
- [ ] Complete 4 one-piece items.
- [ ] Complete 6 shoes.
- [ ] Complete 10 wearable accessories.
- [ ] Complete 8 props.
- [ ] Complete 8 backgrounds.
- [ ] Export thumbnails and full-resolution layers.
- [ ] Generate and review all compatibility contact sheets.

## Phase 6 — QA and Release

- [ ] Cross-platform render comparison.
- [ ] Offline and sync testing.
- [ ] Concurrent edit conflict testing.
- [ ] Catalog migration testing.
- [ ] Low-memory device testing.
- [ ] Accessibility audit.
- [ ] IP/originality review of all art.
- [ ] Gradual rollout behind a feature flag.

---

# 23. Future Extensions

After MVP, the same architecture can support:

- Seasonal outfit packs.
- Workspace-branded clothing.
- Animated blink, breathing, wave, and thinking states.
- Additional poses and gestures.
- Creator-submitted packs with review and moderation.
- Agent-earned cosmetic items.
- Collaborative team outfit sets.
- Local personal appearance overrides.
- Sticker export for chat reactions.
- Avatar-based emoji/sticker packs generated from the saved character.
- Special event backgrounds.

Any future extension must preserve the rule that the animal body remains monochrome and the Kordi art remains original.

---

# 24. Final Product Principle

The avatar should communicate **who the Agent is** through its animal silhouette, expression, clothing, and prop, while still looking unmistakably like one member of the same Kordi family.

The simplest rule for every design review is:

> **Black-and-white paper animal. Colorful watercolor clothes. One shared Kordi world.**

# Canonical avatar system

Kordi stores one canonical avatar descriptor for every persistent human account and Cloud Agent. The server is the source of truth. Desktop and iOS render the same descriptor, so a change made on one device appears everywhere after normal cloud synchronization.

## Descriptor

The descriptor contains:

- `entityType` and `entityId`
- `source`: `generated` or `uploaded`
- `style`: `lorelei` for humans; `kordi-birds` for agents (older agents may still carry the legacy `thumbs` style)
- a stable opaque `seed`
- the pinned `rendererVersion`
- the uploaded image data when `source` is `uploaded`
- a monotonic `version` and `updatedAt` timestamp

Uploaded images take precedence without deleting the generated seed. Removing an upload restores the prior generated identity. Regenerating replaces the seed and increments the version. Mutations may include `expectedVersion`; a stale client receives an avatar conflict instead of overwriting a newer change.

Signup previews use a client-generated opaque seed that the server requires, validates, and persists, so the chosen Lorelei avatar remains identical after account creation. Profile photo uploads happen after signup through the canonical avatar mutation contract. Migration keeps existing identities deterministic by backfilling from their persistent account or Agent ID only when no durable seed already exists.

Generated avatars are represented in existing avatar URL fields by an internal marker:

```text
kordi-avatar://dicebear-rust-10.6.0-styles-10.5.0/<style>/<seed>?version=<version>
```

This marker is not a network URL. Clients resolve it against their configured Kordi API origin and request the corresponding immutable PNG from `/v1/avatars/...`. Existing uploaded PNG, JPEG, and WebP data URLs remain supported.

## Rendering and caching

The Cloud server renders generated avatars locally with pinned dependencies:

- `dicebear-core` 10.6.0
- `dicebear-styles` 10.5.0 with only `lorelei` and `thumbs` enabled
- `resvg` 0.48.1, which also rasterizes the in-repo `kordi-birds` templates

Runtime clients never call the public DiceBear API. The server keeps a bounded in-memory render cache and returns immutable cache headers. Current canonical descriptors and a durable historical render-key allowlist reject arbitrary seed generation while preserving every immutable avatar URL. Signup and local Agent previews use the same throttled renderer through `/v1/avatars/preview/<style>/...`. Desktop and iOS keep the last valid image visible while a replacement loads or the network is temporarily unavailable.

The default “My Kordi” agent uses the cross-device seed `cloud-local-agent`; runtime- and session-specific IDs must never replace it. Every Cloud Agent stores one seed on the server, so every reference to one person or Agent resolves to the same avatar.

The `dicebear-core` crate is MIT licensed. The selected Lorelei and Thumbs artwork is CC0 1.0. `resvg` is licensed under Apache-2.0 or MIT. Any renderer or style upgrade must use a new renderer version in the marker so existing identities remain reproducible.

## Bird avatars for agents

`kordi-birds` is an agent style of original paper-cut bird portraits in the Kordi logo family. The artwork was drawn for Kordi; no Icons8 or other third-party icon files are used. It uses the same marker, renderer version, routes, render cache, throttle and render-key allowlist as the DiceBear styles; only `render_png` fills an in-repo SVG template instead of calling DiceBear. `thumbs` stays renderable so every stored avatar URL keeps working.

A bird is 16 species × 3 tones (`color`, `slate`, `ink`) × 8 background palettes (`paper`, `rice`, `coral`, `sakura`, `butter`, `mint`, `sky`, `lavender`). Seeds map to a bird on every platform with the same tables, in the same order:

- `bird-<species>-<tone>-<palette>` names one bird; `bird-<species>-<palette>` means tone `color`.
- Any other seed (existing random seeds, `default-agent-<account>`, Agent IDs, `cloud-local-agent`) hashes with FNV-1a 32-bit over its bytes: species `h % 16`, palette `(h >> 8) % 8`, tone `color`. A `bird-` seed with an unknown species or palette also hashes.

A `regenerate` mutation whose seed starts with `bird-` sets an agent's style to `kordi-birds`; any other seed keeps the current style, and people keep Lorelei.

`scripts/kordi-birds/birds.mjs` is the single source of the geometry and tables. `node scripts/kordi-birds/generate.mjs` writes the 48 server templates in `bridges/cloud-server/src/avatars/birds/templates/` (square, background fill `__BG__`, clients clip the shape), their Rust table, the browser preview script, and `scripts/kordi-birds/fixtures.json`, which the server, desktop and iOS tests share; `--check` fails when an output is stale. Templates use only features resvg renders like a browser: paths, rects, circles, ellipses, linear gradients and clip paths. A redraw that changes existing pictures ships as a new style id such as `kordi-birds-2`.

New agents start as birds. Every account's default agent (the `cloud_default_agent_profiles` row its sign-up trigger creates), new Factory agents, and the PiP, support and System agents get a random seed `bird-<species>-color-<palette>`: species and palette uniform, tone `color`. The server draws it with `random_bird_seed` in `src/avatars/birds.rs`; the sign-up trigger uses the SQL function `random_bird_avatar_seed()` from migration 155, and a unit test keeps both tables equal. A Factory agent created with an explicit pick or upload keeps that choice.

Migration 155 moves every agent avatar with `avatar_source = 'generated'` and `avatar_style = 'thumbs'` in `cloud_agent_definitions` and `cloud_default_agent_profiles` to `kordi-birds`. It keeps the seed, so each agent keeps the bird an updated desktop already draws for its `thumbs` marker. It also sets `avatar_version + 1`, rewrites `avatar_url` to the new marker, and sets `avatar_updated_at`. It first copies each moved `(renderer, 'thumbs', seed)` into `cloud_avatar_render_keys`, so cached `thumbs` URLs keep resolving. Uploaded photos, picked birds and people are unchanged. The versioned route serves moved rows from their own table, so they need no new `kordi-birds` render key. Each statement matches only rows still on `thumbs`, so a second run changes nothing.

Rollout: (1) desktop and iOS learn to render `kordi-birds`; (2) migration 149 lets the three tables store the style, and the server renders it; (3) migration 155 and the server change above make birds the default. Step 3 must not reach production before a desktop release that contains #2063 and #2086. Released clients behave like this with a `kordi-birds` agent:

- Desktop 0.0.2-beta.5.2 drops any Factory agent definition with an unknown style from the Agents page, @-mentions, shared-agent routing and connector grants. Create, update and archive save on the server, then fail with "Agent response was invalid.", and a retried create makes a duplicate the user cannot see. A default agent profile still loads, because accounts, contacts and profiles are not validated. The account's own Kordi agent shows a plain grey tile. Contacts' agents mostly show the grey tile, and group members' agents show the server's `thumbs` preview for `default-agent-<account>`. Sign-in and stored data are unaffected.
- iOS build 7, which has no bird support (draft #2058), decodes everything. Default agents (own, contacts and group members) show a plain tile, because the fallback seed `cloud-agent:<account>` is not a valid preview seed. Factory agents show a `thumbs` preview keyed on the agent ID, a different face than before.

Ship iOS bird support (#2058) with or before step 3, or accept plain tiles on iOS until it ships.

## Migration

The one-time database migration preserves existing uploaded images. Accounts without an uploaded image are backfilled with Lorelei using their account ID as the stable seed; agents are backfilled with Thumbs using their agent ID, and migration 155 later moves generated Thumbs agents to `kordi-birds` (see above). After migration, every writer must provide the complete descriptor fields or an explicit avatar mutation; the schema has no compatibility trigger or descriptor defaults.

Avatar writes and durable sync events commit atomically. Owners receive their complete canonical snapshot; contacts and active conversation participants receive a safe directory invalidation and fetch authoritative public state. On desktop, `account.directory.changed` names the changed account. The app refetches only members its groups have loaded, collecting a burst for 300 ms. It then rewrites their group identities, so existing rows and their default agent's replies redraw without a restart. Shared Agent invalidations contain only owner and Agent IDs, never prompts, resources, or provider configuration.

# Kordi bird avatars

`birds.mjs` is the source of truth for the `kordi-birds` agent avatar style: the
16 species, 3 tones (`color`, `slate`, `ink`), 8 background palettes, the seed
grammar and the FNV-1a fallback hash. Every file listed below is generated from it.
Do not edit those files by hand.

Regenerate (plain Node, no dependencies):

```sh
node scripts/kordi-birds/generate.mjs
node scripts/kordi-birds/generate.mjs --check   # CI-style staleness check
node --test scripts/kordi-birds.test.mjs
```

Outputs:

- `docs/design-previews/agent-bird-avatars/birds.js`: browser build of the
  generator for the design preview page (`window.KordiBirds`).
- `bridges/cloud-server/src/avatars/birds/templates/<species>-<tone>.svg`: 48 square
  server templates whose background fill is the literal `__BG__`; the server
  substitutes the palette colour and rasterizes with resvg.
- `bridges/cloud-server/src/avatars/birds/templates.rs`: the template table.
- `fixtures.json`: seed-to-avatar fixtures every platform must satisfy.

Templates may use only paths, rects, circles, ellipses, linear gradients and clip
paths, so the server rendering matches the browser. When the species, tone or
palette tables change, update `bridges/cloud-server/src/avatars/birds.rs` and the
desktop and iOS tables too. A redraw that changes existing pictures ships as a new
style id (for example `kordi-birds-2`) so immutable avatar URLs stay stable.

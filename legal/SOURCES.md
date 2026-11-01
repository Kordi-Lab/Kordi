# Third-party source access and library modifications

Kordi is MIT licensed. Components listed in inventory.json retain their own
licenses. Each entry links to the exact upstream source version, including
MPL-covered files. Original upstream notices and full standard license texts
are provided alongside this document. Build tools and optional target packages
are disclosed conservatively; this inventory is not a claim they all ship.

## MPL-covered components

Recipients can obtain source from the exact-version links in inventory.json.
This includes option-ext 0.2.0. ICAL.js 2.2.1's upstream archive is available at
https://registry.npmjs.org/ical.js/-/ical.js-2.2.1.tgz and includes its preferred
source files. The MPL portions remain available under MPL-2.0. Kordi does not
restrict your rights to those files. Changes to covered files, if any, must be
included with the source supplied for the release.

## Compiled Bun runtime

Kordi's standalone OMP worker uses Bun 1.4.2. Bun's own code is MIT licensed;
JavaScriptCore/WebKit and TinyCC have LGPL terms. The upstream licensing and
rebuild instructions are retained in the Bun entry. Bun source is available at
https://github.com/oven-sh/bun/tree/bun-v1.4.2 and its WebKit fork at
https://github.com/oven-sh/WebKit. The exact WebKit revision is specified by
WEBKIT_VERSION in scripts/build/deps/webkit.ts at that Bun tag.

The demonstrated procedure is in docs/runtime-relinking.md and in the source
kit's build-patches archive. It uses the pinned WebKit source with
`BUN_WEBKIT_PATH`, the local TinyCC source, and Bun's version-specific build
script. Use the resulting Bun executable to compile the Kordi worker from the
matching release source with the frozen Bun lockfile. Kordi's
shared/omp-runtime/scripts/build-standalone.mjs records the compiler version in
runtime-build.json. Preserve that record with the runtime bundle.

The source download link for this exact release is included below and in the
license viewer. The separate kit contains the pinned libraries, Kordi worker
source, frozen dependencies, original notices and rebuild instructions. Source
parts and reconstructed archives are SHA-256 verified. The installer does not
need to contain the multi-gigabyte source archives. Keep source downloads
available for as long as the corresponding binaries remain downloadable.

See docs/runtime-relinking.md in Kordi's source for the demonstrated macOS arm64
rebuild and replacement procedure. Recipients may modify covered libraries and
reverse engineer the combined work for debugging those modifications as
permitted by the applicable LGPL. No Kordi terms remove those rights. For
multi-license OR expressions, Kordi uses the available permissive alternative
(for example, BSD for zstd and MIT for r-efi); original terms remain included.

## Optional libvips

OMP declares an optional Transformers dependency that can bring sharp and
LGPL-3.0-or-later libvips into an installation. The exact locked versions are
listed in inventory.json. Whether those native objects are shipped is assessed
on the final release, not inferred from lockfile membership. If included, retain
its dependency notices and provide the applicable source and replacement or
relink materials. Do not substitute the older versions listed in OMP's aggregate
notice for Kordi's resolved versions.

## Native iOS frameworks

LiveKit Swift, LiveKit UniFFI, SwiftProtobuf and the WebRTC package notices are
included at the pinned revisions. SwiftProtobuf's license includes its Runtime
Library Exception. The MIT license of the WebRTC package wrapper does not
replace the licenses of the embedded WebRTC libraries. The reviewed WebRTC and UniFFI native notices and dependency inventories are
included in this viewer. UniFFI uses MPL-licensed UniFFI crates; their exact
source archives are linked from the retained dependency records. A rebuild of
the iOS arm64 UniFFI framework passed both Swift and C interface comparisons.
The release check binds framework contents to reviewed executable section
hashes, which remain stable when the application is signed.

## Artwork

Noto Animated Emoji: Copyright Google LLC, CC BY 4.0.
Project: https://googlefonts.github.io/noto-emoji-animation/
License: https://creativecommons.org/licenses/by/4.0/
Kordi resizes and arranges thumbnail images; animations are loaded from the
Google Fonts CDN. These notices apply when the artwork is displayed or shared.
Static copyright and registered symbols use Apache-2.0 Noto artwork. Blob Emoji
retains its Apache-2.0 copyright and license notices. DiceBear Lorelei artwork is
CC0; other styles in dicebear-styles have their own terms. Provider names and
logos identify their owners and do not imply endorsement.

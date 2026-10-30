# License maintenance and release verification

Kordi's first-party license is MIT. Third-party licenses remain separate.
The reviewed material in `legal/` is compliance documentation intentionally
retained in source control, including original upstream texts. It is not a
collection of application build outputs. Do not edit upstream copyright or
license text to make it look like Kordi-owned code.

## Updating dependencies

1. Update and freeze the relevant lockfiles.
2. Run `pnpm licenses:refresh` with Python 3.11+, Cargo, Go, Node and installed
   workspace dependencies. It reads public package archives without executing
   their code. npm archives are checked against lockfile integrity values.
   Cargo validates its registry downloads. License evidence is cached only in
   `.build/license-cache`; Go resolution uses a temporary module directory.
3. Review the changed identities, licenses, original notices and source URLs in
   `legal/catalog.json`, including any `manifest-and-canonical-license` entries.
   These packages omit standalone notice files; metadata and a generic license
   template alone do not settle unusual authorship or licensing questions.
4. Review native runtime versions and artwork separately. A wrapper license
   does not cover every library in a binary framework. The DiceBear exception
   is limited to Lorelei; other styles keep their own terms.
5. Run `pnpm licenses:check` and `node --test scripts/licenses.test.mjs`.
   Commit the reviewed catalog and `legal/distribution` together. Public upstream
   attribution email addresses are preserved verbatim; the privacy guard permits
   only their reviewed hashes from `legal/public-contact-hashes.json`, limited to
   the generated attribution and explicitly named native notice/inventory files. Other privacy rules and denylist checks still
   apply. Review changes to that hash list with the upstream source notices.

The catalog is a conservative inventory of frozen graphs, including build,
test and optional-platform packages. It is not a target-specific SBOM. SPDX
`OR` alternatives permit a choice; `AND` obligations accumulate. In particular,
permissive alternatives in r-efi do not force LGPL on Kordi. New license
identifiers fail collection and require review. A changed lockfile fails the
normal offline check until the reviewed data is regenerated.

## Delivery paths

- Desktop web assets: the build stages `/licenses/index.html`; Help provides an
  offline viewer. Tauri also bundles `legal/distribution` as `licenses/` in
  app resources, allowing inspection without launching the app.
- iOS: the document-editor build stages the same material in app resources.
  Settings > Open-source licenses reads it locally, including Noto attribution.
- CLI: `kordi licenses` and `bridges licenses` print compiled-in notices and
  versioned source links, including for standalone binary downloads. npm prepack
  also copies an actual `licenses/` directory; npm symlink behavior is not used.
- OMP: standalone builds reject an unreviewed Bun compiler version and copy
  the notices plus `runtime-build.json` beside the runtime assets. Keep the
  entire `licenses/` directory when distributing runtime assets independently.
- Server/runner images: notices are at `/usr/local/share/kordi/licenses`.
  Before building a Temporal image from its smaller context, run
  `node scripts/licenses.mjs stage bridges/cloud-temporal-bridge/licenses`.
  The legacy bridge-only Docker build similarly needs `bridges/licenses`.

`node scripts/licenses.mjs verify <extracted-license-directory>` checks every
required file against the reviewed source data. Verify extracted signed app,
DMG, IPA, npm and container contents, not just a staging directory. The desktop
publisher verifies the top-level app, updater archive and mounted DMG copies.
No packaging check asserts a legal conclusion merely because a file exists.

## LGPL source and relink materials

The macOS arm64 demonstration in `legal/runtime-relink-verification.json`
rebuilt JavaScriptCore and TinyCC, observed both modifications, rebuilt the
worker, and passed startup and native-worker protocol probes. The verifier
rejects stale source pins, changed worker source/locks and incomplete probes.
The test modifications are in `legal/runtime-patches`; the modified binaries
are not product releases. See [the tested procedure](runtime-relinking.md).

Prepare a source kit from the clean, committed and reviewed release checkout, including its exact
Bun build inputs and vendored Rust crates:

```sh
python3 scripts/licenses/prepare-sources.py --output .build/release-sources
python3 scripts/licenses/complete-source-kit.py --output .build/release-sources \
  --bun-source <verified-bun-source> --rust-vendor <verified-rust-vendor>
node scripts/licenses/source-delivery.mjs .build/release-sources \
  .build/source-downloads <release-version> <release-commit>
```

The kit contains nine material groups, including all tested worker dependencies
and Bun native/build inputs. Parts are at most 64 MiB. `manifest.json` binds
parts, reconstructed archives, catalog digest and release commit. The source
URL is `/updates/releases/<version>/sources/manifest.json` on the same public
origin as application downloads. `download-sources.py` reconstructs archives
with hash verification without executing them. Keep immutable sources available
while the corresponding binaries are offered for download. No written-offer
fulfillment route is used.

Set `KORDI_LICENSE_SOURCE_KIT` to the prepared download directory and
`KORDI_LICENSE_RELEASE_EVIDENCE` to the local artifact review JSON. That JSON
requires `schemaVersion: 1`, `reviewStatus: "complete"`, `catalogSha256`,
`sourceManifestSha256`, and `artifacts` containing SHA-256 values for the final
signed OMP worker and native addon. `reviews` must record substantive findings
for `bun-javascriptcore`, `bun-tinycc`, `omp-native-addon`, and `optional-libvips`.
The publisher verifies all app copies, uploads immutable source parts and their
manifest, verifies anonymous public downloads, and only then promotes the
application release. Conflicts, inaccessible sources or incorrect bytes block
promotion. The source route must be deployed before using this publication
flow; local tests and source preparation do not deploy it.

The source kit is separate from the installer. The earlier bundled-source
verification helper remains available for tests or explicitly reviewed local
bundles; production publication uses the version-bound download kit.
Code-signing identities and private logs stay outside public evidence.

## Native dependency review

`legal/native/webrtc-dependencies.json` pins the WebRTC source, archive and
Apple build configuration. It includes 32 conservative component notice sets
from the pinned upstream generator mapping (`collect-webrtc.py` reproduces the collection), with original license/patent files
retrieved at DEPS revisions. Android dependencies and disabled H.264/protobuf
implementations are excluded. The obsolete base64 path was checked against the
actual default Abseil implementation; experimental Rust base64 is disabled.
This conservative attribution coverage is not a target-specific link-map SBOM.

`legal/native/uniffi-dependencies.json` contains the 235-package normal/build
iOS dependency closure of `livekit-uniffi`. It excludes unrelated workspace
packages, WebRTC, OpenSSL and soxr. The source-built device framework matched
the pinned Swift and C interfaces. Exact crate source links preserve MPL source
access. Bun's additional native, Rust and bundled-JS notices are retained too.
`inspect-runtime.ts` records the actual 3,670-input worker bundle: optional
sharp/libvips are absent. The OMP addon links only Apple/system libraries;
its original third-party notices are retained. Production verification checks
its reviewed Mach-O section identity, permitting signature changes but rejecting
changed native code. Repeat this review when the worker or lockfiles change.

`verify-ios.py` checks the actual app's notices, complete embedded-framework
inventory and reviewed arm64 loadable-section hashes. These hashes exclude
signatures and load commands, so signing does not require a false new dependency
review. Release configuration builds run this check after embedding frameworks;
unreviewed versions fail. Run it again on the exported IPA contents. Device
releases use the reviewed source-built UniFFI preparation; the upstream binary
has no notices and is not silently accepted as an equivalent reviewed build.

These checks establish retained licensing material, tested source replacement,
and artifact identity for the reviewed versions. They do not certify patent
clearance, trademark rights or any unrelated proprietary code.

# Reviewed release licensing scope

The first-party project remains MIT. The copyright owner confirmed ownership
of the first-party code introduced during the Apache-2.0 interval, permitting
the subsequent MIT grant. Third-party terms and notices remain separate.

The completed validation covers the frozen dependencies in this checkout:

- macOS arm64: Bun 1.4.2, OMP 18.12.6, modified JavaScriptCore and TinyCC rebuilds,
  changed executable identity, worker readiness and evaluation/browser probes,
  and execution of C compiled by the modified TinyCC library.
- Runtime packaging: 3,670 bundled inputs inspected; optional sharp/libvips
  excluded from this worker. The OMP native addon links to system libraries and
  its reviewed section identity is checked again during release verification.
- iOS arm64: WebRTC original notices plus 32 conservative component notice sets;
  source-built UniFFI with its 235-package normal/build dependency closure;
  matching C/Swift interfaces; an actual Kordi Beta device build; verification
  of the embedded frameworks and license payload. Ad-hoc signature changes
  were tested to preserve section identity.
- Distribution: original notices and versioned source access in desktop, iOS,
  CLI, runtime and image packaging. The nine-group source kit binds its exact
  source snapshot to a clean commit and uses verified bounded downloads.
- Regression checks: repository privacy, English, whitespace and maintenance
  checks; 373 script tests and 27 CI script tests; 47 update-server tests;
  desktop type checking, lint and production web build; iOS device build and
  post-build framework/license verification.

See [license maintenance](license-compliance.md) for evidence files and
[the replacement procedure](runtime-relinking.md) for rebuilding covered
libraries. Original native licenses are in `legal/native`; distribution
notices are in `legal/distribution`.

## Publication requirements

No production deployment or source upload is implied by these local results.
Deploy the public source route before publishing a release. Prepare source
materials from that release's clean commit, then let the publisher upload and
verify every source part anonymously before it changes release channels.
An inaccessible or conflicting source kit fails publication. Do not garbage
collect sources while the corresponding binaries remain available.

Final signed desktop artifacts must match their artifact-bound evidence.
Exported iOS IPA contents must pass `verify-ios.py`; the reviewed source-built
UniFFI device framework is required. Other architectures and changed native
versions need new evidence. These checks cover software-license delivery and
replacement obligations; they do not determine patent or trademark clearance.

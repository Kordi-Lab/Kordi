# Rebuilding and replacing the LGPL libraries

The verified target is macOS arm64, Bun 1.4.2 and OMP 18.12.6. The recorded
experiment rebuilt JavaScriptCore and TinyCC with observable test markers,
rebuilt the worker with that Bun executable, and passed both worker readiness
and the existing native worker evaluation/browser smoke protocol. A separate
TinyCC probe compiled and executed C code. Original and modified worker hashes
are different. The probe binaries are test artifacts, not product releases.

`legal/runtime-relink-verification.json` contains hashes and Boolean results,
not private logs. It is invalidated when the worker sources, locks or Bun source
pins change. `scripts/licenses/verify-relink.py` reruns those checks. The release
publisher also binds its evidence to the actual signed worker and native addon.

## Obtain the matching materials

The offline license page links to the exact release's source manifest at
`https://kordi.ai/updates/releases/<version>/sources/manifest.json`. Source parts
are at the same download origin as the application. Use Python 3.11 or later:

```sh
python3 scripts/licenses/download-sources.py \
  --manifest https://kordi.ai/updates/releases/<version>/sources/manifest.json \
  --output sources
```

The downloader checks individual parts and reassembled archive hashes without
executing any code. The kit contains Bun, the exact WebKit and TinyCC revisions,
Bun's native/build inputs, its vendored Rust crates, frozen worker dependencies,
Kordi's worker source, original notices, and patches. The large sources are
separate downloads; they are not included in the normal application installer.

## Rebuild

The demonstrated prerequisites are LLVM 21.1.8, Ninja, CMake, Python, Git, Bun
1.4.2, Rust nightly-2026-07-20, and the macOS/Xcode SDK. The system compiler/SDK
and operating-system libraries are installed separately. Bun's source archive
contains its full upstream build documentation and pinned build scripts.

Use an empty directory. Extract `bun.tar.gz` into `bun/` with its leading
archive directory removed. Extract `javascriptcore.tar.gz` directly into
`webkit/` (that archive has no leading directory). Extract `tinycc.tar.gz` into
`tinycc/` with its leading directory removed. Then:

```sh
tar -xzf sources/bun-build-inputs.tar.gz -C bun
tar -xzf sources/bun-rust-dependencies.tar.gz -C bun
mkdir kordi
tar -xzf sources/application.tar.gz -C kordi
tar -xzf sources/application-dependencies.tar.gz -C kordi
tar -xzf sources/build-patches.tar.gz
```

Bun's build tools require Git metadata. Initialize `bun/`, fetch the exact
`bun-v1.4.2` tag from `https://github.com/oven-sh/bun.git`, and use
`git reset --mixed FETCH_HEAD` there to record that identity without replacing
the supplied source files. Do not run that command in your Kordi checkout.
Apply `patches/macos-sdk-compatibility.patch` to Bun with `git apply`. This
narrow patch permits an SDK attribute unknown to the pinned LLVM compiler.
Bun regenerates its repository Cargo configuration. Put the following source
configuration in a separate `cargo-home/config.toml` and set `CARGO_HOME` to
that directory when building. Replace the vendor path with your extracted path:

```toml
[source.crates-io]
replace-with = "vendored-sources"
[source.vendored-sources]
directory = "/absolute/path/to/bun/vendor-crates"
```

Make the desired WebKit/TinyCC modifications. To reproduce the demonstration,
apply `javascriptcore-proof.patch` under `webkit/` and `tinycc-proof.patch`
under `tinycc/` using `git apply`. They print distinct markers and are unnecessary
for ordinary library replacement. From `bun/`, with LLVM 21 in `PATH`, run:

```sh
CARGO_HOME="$PWD/../cargo-home" RUSTUP_TOOLCHAIN=nightly-2026-07-20 \
  BUN_WEBKIT_PATH=../webkit \
  bun scripts/build.ts --profile=release-local --local-deps=tinycc=../tinycc -j6
```

The result is `bun/build/release/bun`. Put that executable in a dedicated
`PATH` directory under the name `bun`. From the extracted `kordi/` directory:

```sh
node shared/omp-runtime/scripts/build-standalone.mjs runtime-out aarch64-apple-darwin
runtime-out/kordi-omp-aarch64-apple-darwin __kordi_smoke_eval
```

Expected smoke output is
`eval-result-2;computer-capabilities-ready;browser-worker-closed`.
The standalone worker uses the rebuilt Bun executable, as verified by the
JavaScriptCore marker in the compiled worker. Keep the matching
`pi_natives.darwin-arm64.node` beside the worker. Replace `kordi-omp` in your
own copy of the application with this worker, preserving the matching addon.
Modifying a signed application invalidates its signature; an owner can ad-hoc
sign that local copy with `codesign --force --deep --sign - <app-copy>`.
No Kordi terms prohibit covered-library modification or reverse engineering
for debugging such modifications. This procedure grants no additional rights
to Apple SDKs or third-party trademarks.

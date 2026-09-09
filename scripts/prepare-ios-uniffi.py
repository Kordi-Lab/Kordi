#!/usr/bin/env python3
"""Build the pinned LiveKit UniFFI iOS device dependency without private paths.

Only use a task-owned SwiftPM directory: this intentionally replaces that
checkout's remote binary target with an explicitly local source-built target.
It never modifies the downloaded binary artifact or a global package cache.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

SOURCE_COMMIT = "598d0e3bd09b382db12e0ea0d117238763737c76"
PROTOCOL_COMMIT = "f734574de339d94dd83f70fbe1723ba1cdc61c2f"
PACKAGE_COMMIT = "7c161254ce7cd55debc48023f69a917076b12a26"
BINARY_CHECKSUM = "0d3f2ce159a224c728f8b131068d53bbf9b13d968cda0edc68a6a2290f2651ed"
NAME = "RustLiveKitUniFFI"
LOCAL_TARGET = "KordiSourceBuilt/RustLiveKitUniFFI.xcframework"
URL = "https://github.com/livekit/livekit-uniffi-xcframework/releases/download/0.0.6/RustLiveKitUniFFI.xcframework.zip"
INSTALL_NAME = "@rpath/RustLiveKitUniFFI.framework/RustLiveKitUniFFI"
FORBIDDEN = (b"/Users/", b"/private/tmp", b"/var/folders/")


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def manifest_override(text):
    old = f'url: "{URL}",\n            checksum: "{BINARY_CHECKSUM}"'
    require(text.count(old) == 1, "Unexpected pinned package manifest")
    return text.replace(old, f'path: "{LOCAL_TARGET}"')


def compare_bindings(original, generated):
    # The upstream packaging tool adds blank lines. Preserve all other bytes.
    meaningful = lambda value: [line for line in value.splitlines() if line.strip()]
    require(meaningful(original) == meaningful(generated), "Swift interface mismatch")


def check_privacy(data):
    require(not any(pattern in data for pattern in FORBIDDEN),
            "Dependency contains a forbidden build path")


def prepare(args):
    os.umask(0o077)
    source, build, packages = (Path(value).resolve() for value in
                               (args.source, args.build, args.packages))
    require(source != build and not source.is_relative_to(build)
            and not build.is_relative_to(source), "Use separate source and build directories")
    require(os.environ.get("DEVELOPER_DIR"), "Select DEVELOPER_DIR explicitly")
    package = packages / "checkouts/livekit-uniffi-xcframework"
    require(package.is_dir(), "Resolve pinned Swift packages into the task-owned directory first")
    build.mkdir(parents=True, exist_ok=True)
    log = (build / "prepare.private.log").open("w")

    def run(command, cwd=None, env=None, capture=False):
        result = subprocess.run(command, cwd=cwd, env=env,
                                stdout=subprocess.PIPE if capture else log, stderr=log)
        require(result.returncode == 0, "Dependency preparation failed; inspect the private build log")
        return result.stdout.decode() if capture else None

    def git(directory, *arguments):
        return run(["git", "-C", str(directory), *arguments], capture=True).strip()

    require(git(package, "rev-parse", "HEAD") == PACKAGE_COMMIT,
            "Unexpected Swift wrapper revision")
    require(not git(package, "status", "--porcelain", "--", "Sources"),
            "Swift wrapper sources have local changes")
    originals = {name: git(package, "show", f"HEAD:{name}") + "\n"
                 for name in ("Package.swift", "Package@swift-6.2.swift")}
    for name, original in originals.items():
        current = (package / name).read_text()
        require(current in (original, manifest_override(original)),
                "Refusing to overwrite unrelated package manifest changes")

    if not source.exists():
        run(["git", "clone", "--no-checkout", "https://github.com/livekit/rust-sdks.git", str(source)])
        run(["git", "-C", str(source), "-c", "filter.lfs.required=false",
             "-c", "filter.lfs.process=", "-c", "filter.lfs.smudge=cat",
             "checkout", "--detach", SOURCE_COMMIT])
    require(git(source, "rev-parse", "HEAD") == SOURCE_COMMIT,
            "Unexpected Rust dependency source revision")
    require(not git(source, "status", "--porcelain", "--untracked-files=no"),
            "Rust dependency sources have local changes")
    run(["git", "-C", str(source), "submodule", "update", "--init", "livekit-protocol/protocol"])
    require(git(source / "livekit-protocol/protocol", "rev-parse", "HEAD") == PROTOCOL_COMMIT,
            "Unexpected protocol revision")
    require(not git(source / "livekit-protocol/protocol", "status", "--porcelain"),
            "Protocol sources have local changes")
    env = os.environ.copy()
    # No caller-provided compiler flags or wrappers may change the qualified build.
    for key in list(env):
        if key.startswith(("CARGO_ENCODED_", "CARGO_TARGET_", "RUSTFLAGS", "RUSTC_WRAPPER",
                           "RUSTC_WORKSPACE_WRAPPER", "CFLAGS", "CXXFLAGS")):
            env.pop(key)
    env.update(CARGO_TARGET_DIR=str(build), CARGO_BUILD_JOBS="1",
               IPHONEOS_DEPLOYMENT_TARGET="13.0", MACOSX_DEPLOYMENT_TARGET="11.0")
    remaps = [(Path.home(), "/build"), (source, "/build/livekit"), (build, "/build/target")]
    # Encoded flags support paths with spaces without shell interpretation.
    env["CARGO_ENCODED_RUSTFLAGS"] = "\x1f".join(
        f"--remap-path-prefix={old}={new}" for old, new in remaps)
    env["CFLAGS"] = env["CXXFLAGS"] = " ".join(
        f'"-ffile-prefix-map={old}={new}" "-fdebug-prefix-map={old}={new}"'
        for old, new in remaps)
    manifest = str(source / "livekit-uniffi/Cargo.toml")
    run(["rustup", "target", "add", "aarch64-apple-ios"], env=env)
    run(["cargo", "rustc", "--locked", "--release", "--manifest-path", manifest,
         "--lib", "--target", "aarch64-apple-ios", "--", "-C",
         f"link-arg=-Wl,-install_name,{INSTALL_NAME}"], cwd=source, env=env)
    binary = build / "aarch64-apple-ios/release/liblivekit_uniffi.dylib"
    check_privacy(binary.read_bytes())
    require(INSTALL_NAME in run(["otool", "-D", str(binary)], capture=True),
            "Incorrect framework install name")
    require(run(["lipo", "-archs", str(binary)], capture=True).strip() == "arm64",
            "Incorrect device architecture")
    generated = build / "bindings-check"
    host_env = env.copy()
    host_env.pop("CARGO_ENCODED_RUSTFLAGS")
    run(["cargo", "run", "--locked", "--release", "--manifest-path", manifest,
         "--bin", "uniffi-bindgen", "--", "generate", "--library", str(binary),
         "--language", "swift", "--config", str(source / "livekit-uniffi/uniffi.toml"),
         "--out-dir", str(generated)], cwd=source, env=host_env)
    compare_bindings((package / "Sources/LiveKitUniFFI/livekit_uniffi.swift").read_text(),
                     (generated / "livekit_uniffi.swift").read_text())
    stock = packages / f"artifacts/livekit-uniffi-xcframework/{NAME}/{NAME}.xcframework/ios-arm64/{NAME}.framework"
    require((stock / f"Headers/{NAME}.h").read_bytes() == (generated / f"{NAME}.h").read_bytes(),
            "C interface mismatch")
    framework = build / f"framework/{NAME}.framework"
    framework.mkdir(parents=True, exist_ok=True)
    (framework / "Headers").mkdir(exist_ok=True)
    (framework / "Modules").mkdir(exist_ok=True)
    shutil.copy2(binary, framework / NAME)
    shutil.copy2(generated / f"{NAME}.h", framework / f"Headers/{NAME}.h")
    module = (generated / f"{NAME}.modulemap").read_text()
    require(module.startswith(f"module {NAME} {{"), "Unexpected module declaration")
    (framework / "Modules/module.modulemap").write_text("framework " + module)
    shutil.copy2(source / "livekit-uniffi/support/swift/PrivacyInfo.xcprivacy",
                 framework / "PrivacyInfo.xcprivacy")
    info = dict(CFBundleDevelopmentRegion="en", CFBundleExecutable=NAME,
                CFBundleIdentifier=f"com.cargo-swift.{NAME}", CFBundleInfoDictionaryVersion="6.0",
                CFBundleName=NAME, CFBundlePackageType="FMWK", CFBundleShortVersionString="1.0",
                CFBundleSupportedPlatforms=["iPhoneOS"], CFBundleVersion="1",
                MinimumOSVersion="13.0", UIDeviceFamily=[1, 2])
    (framework / "Info.plist").write_bytes(plistlib.dumps(info))
    target = package / LOCAL_TARGET
    if target.exists():
        require((target.parent / "provenance.json").is_file(),
                "Refusing to replace an unowned local framework")
        shutil.rmtree(target)
    target.parent.mkdir(exist_ok=True)
    run(["xcodebuild", "-create-xcframework", "-framework", str(framework),
         "-output", str(target)], env=env)
    for file in target.rglob("*"):
        if file.is_file():
            check_privacy(file.read_bytes())
    provenance = dict(source_commit=SOURCE_COMMIT, protocol_commit=PROTOCOL_COMMIT,
                      wrapper_commit=PACKAGE_COMMIT, platform="ios-arm64",
                      binary_sha256=hashlib.sha256(binary.read_bytes()).hexdigest(),
                      bindings_match=True, privacy_clean=True,
                      rustc=run(["rustc", "--version"], capture=True).strip(),
                      xcode=run(["xcodebuild", "-version"], env=env, capture=True).strip())
    (target.parent / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
    for name, original in originals.items():
        temporary = package / f"{name}.kordi-tmp"
        temporary.write_text(manifest_override(original))
        temporary.chmod(0o444)
        temporary.replace(package / name)
    print(json.dumps(provenance))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, help="Dedicated pinned Rust source checkout")
    parser.add_argument("--build", required=True, help="Dedicated dependency build directory")
    parser.add_argument("--packages", required=True, help="Task-owned Xcode SourcePackages directory")
    arguments = parser.parse_args()
    try:
        prepare(arguments)
    except (RuntimeError, OSError) as error:
        # OS error strings can include private paths; keep details local.
        print(str(error) if isinstance(error, RuntimeError) else
              "Local dependency preparation failed; inspect the private inputs", file=sys.stderr)
        sys.exit(1)

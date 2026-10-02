use std::{env, path::PathBuf, process::Command};

fn main() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=native/LivePhotos.swift");
        let output = PathBuf::from(env::var_os("OUT_DIR").unwrap());
        let arch = match env::var("CARGO_CFG_TARGET_ARCH").unwrap().as_str() {
            "aarch64" => "arm64",
            "x86_64" => "x86_64",
            _ => panic!("Unsupported macOS architecture"),
        };
        let sdk = Command::new("xcrun")
            .args(["--sdk", "macosx", "--show-sdk-path"])
            .output()
            .expect("macOS SDK");
        assert!(sdk.status.success(), "macOS SDK is required");
        let sdk = String::from_utf8(sdk.stdout).unwrap();
        let status = Command::new("xcrun")
            .args([
                "swiftc",
                "-emit-library",
                "-static",
                "-O",
                "-module-name",
                "KordiLivePhotos",
                "-target",
                &format!("{arch}-apple-macosx12.0"),
                "-sdk",
                sdk.trim(),
                "native/LivePhotos.swift",
                "-o",
            ])
            .arg(output.join("libKordiLivePhotos.a"))
            .status()
            .expect("Swift compiler");
        assert!(status.success(), "Live Photo bridge compilation failed");
        println!("cargo:rustc-link-search=native={}", output.display());
        println!("cargo:rustc-link-lib=static=KordiLivePhotos");
        let compiler = Command::new("xcrun")
            .args(["--find", "swiftc"])
            .output()
            .expect("Swift toolchain");
        let compiler = PathBuf::from(String::from_utf8(compiler.stdout).unwrap().trim());
        let toolchain = compiler.parent().unwrap().parent().unwrap();
        println!(
            "cargo:rustc-link-search=native={}/lib/swift/macosx",
            toolchain.display()
        );
        println!(
            "cargo:rustc-link-search=native={}/lib/swift_static/macosx",
            toolchain.display()
        );
        println!(
            "cargo:rustc-link-search=native={}/usr/lib/swift",
            sdk.trim()
        );
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }
    tauri_build::build()
}

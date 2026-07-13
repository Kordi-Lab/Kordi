use std::collections::BTreeMap;

use base64::Engine;

use super::model::{select_update, ChannelPointer, ReleaseAsset, ReleaseManifest, UpdateDecision};

const VERSION: &str = "0.0.1-beta.6";

fn digest(byte: char) -> String {
    std::iter::repeat_n(byte, 64).collect()
}

fn updater_signature() -> String {
    base64::engine::general_purpose::STANDARD.encode(
        b"untrusted comment: signature from minisign secret key\nRWQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n",
    )
}

fn asset(file_name: &str, signature: Option<String>) -> ReleaseAsset {
    ReleaseAsset {
        object_key: format!("desktop/releases/{VERSION}/macos/aarch64/{file_name}"),
        file_name: file_name.to_string(),
        content_type: if file_name.ends_with(".dmg") {
            "application/x-apple-diskimage".to_string()
        } else {
            "application/gzip".to_string()
        },
        sha256: digest('a'),
        size_bytes: 123,
        signature,
    }
}

fn release() -> ReleaseManifest {
    ReleaseManifest {
        schema_version: 1,
        version: VERSION.to_string(),
        notes: "Kordi beta.6".to_string(),
        pub_date: "2026-07-13T00:00:00Z".to_string(),
        changelog_url: "https://github.com/Kordi-AI/Kordi/releases/tag/V0.0.1.beta6".to_string(),
        manual: asset("Kordi_0.0.1-beta.6_aarch64.dmg", None),
        platforms: BTreeMap::from([(
            "darwin-aarch64".to_string(),
            asset("Kordi.app.tar.gz", Some(updater_signature())),
        )]),
    }
}

fn pointer() -> ChannelPointer {
    ChannelPointer {
        schema_version: 1,
        channel: "beta".to_string(),
        release_manifest_key: format!("desktop/releases/{VERSION}/release.json"),
        release_manifest_sha256: digest('b'),
    }
}

#[test]
fn valid_release_and_channel_metadata_pass_strict_validation() {
    release().validate().unwrap();
    pointer().validate().unwrap();
}

#[test]
fn release_rejects_invalid_version_date_size_digest_and_signature() {
    let mut candidate = release();
    candidate.version = "beta-six".to_string();
    assert!(candidate
        .validate()
        .unwrap_err()
        .to_string()
        .contains("semantic version"));

    let mut candidate = release();
    candidate.pub_date = "next Tuesday".to_string();
    assert!(candidate
        .validate()
        .unwrap_err()
        .to_string()
        .contains("RFC 3339"));

    let mut candidate = release();
    candidate.manual.size_bytes = 0;
    assert!(candidate
        .validate()
        .unwrap_err()
        .to_string()
        .contains("positive"));

    let mut candidate = release();
    candidate.manual.sha256 = digest('A');
    assert!(candidate
        .validate()
        .unwrap_err()
        .to_string()
        .contains("SHA-256"));

    let mut candidate = release();
    candidate
        .platforms
        .get_mut("darwin-aarch64")
        .unwrap()
        .signature = Some("template-signature".to_string());
    assert!(candidate
        .validate()
        .unwrap_err()
        .to_string()
        .contains("signature"));
}

#[test]
fn release_rejects_unknown_platform_unsafe_file_and_out_of_prefix_object() {
    let mut candidate = release();
    let updater = candidate.platforms.remove("darwin-aarch64").unwrap();
    candidate
        .platforms
        .insert("linux-x86_64".to_string(), updater);
    assert!(candidate
        .validate()
        .unwrap_err()
        .to_string()
        .contains("platform"));

    for file_name in [
        "../Kordi.dmg",
        "nested/Kordi.dmg",
        "nested\\Kordi.dmg",
        "%2fKordi.dmg",
    ] {
        let mut candidate = release();
        candidate.manual.file_name = file_name.to_string();
        assert!(
            candidate.validate().is_err(),
            "accepted unsafe filename {file_name}"
        );
    }

    let mut candidate = release();
    candidate.manual.object_key = "desktop/releases/0.0.1-beta.5/Kordi.dmg".to_string();
    assert!(candidate
        .validate()
        .unwrap_err()
        .to_string()
        .contains("release prefix"));
}

#[test]
fn channel_pointer_rejects_unsafe_manifest_keys_and_invalid_digests() {
    for key in [
        "desktop/channels/beta/latest.json",
        "desktop/releases/0.0.1-beta.6/../release.json",
        "desktop/releases/0.0.1-beta.6/%2frelease.json",
    ] {
        let mut candidate = pointer();
        candidate.release_manifest_key = key.to_string();
        assert!(candidate.validate().is_err(), "accepted unsafe key {key}");
    }

    let mut candidate = pointer();
    candidate.release_manifest_sha256 = "not-a-digest".to_string();
    assert!(candidate
        .validate()
        .unwrap_err()
        .to_string()
        .contains("SHA-256"));
}

#[test]
fn semantic_prerelease_ordering_offers_beta6_to_beta5_1_without_downgrades() {
    assert!(matches!(
        select_update(&release(), "darwin", "aarch64", "0.0.1-beta.5.1").unwrap(),
        UpdateDecision::Update(_)
    ));
    assert!(matches!(
        select_update(&release(), "darwin", "aarch64", "0.0.1-beta.6").unwrap(),
        UpdateDecision::NoUpdate
    ));
    assert!(matches!(
        select_update(&release(), "darwin", "aarch64", "0.0.1-beta.7").unwrap(),
        UpdateDecision::NoUpdate
    ));
    assert!(matches!(
        select_update(&release(), "windows", "x86_64", "0.0.1-beta.5").unwrap(),
        UpdateDecision::Unsupported
    ));
}

#[test]
fn malformed_current_client_version_fails_closed() {
    assert!(select_update(&release(), "darwin", "aarch64", "latest").is_err());
}

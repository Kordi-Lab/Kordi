use axum::extract::Path;
use axum::http::header::USER_AGENT;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;

const DEFAULT_DESKTOP_UPDATE_RELEASE_API_URL: &str =
    "https://api.github.com/repos/Kordi-AI/Kordi/releases/latest";
const DESKTOP_UPDATE_RELEASE_API_URL_ENV: &str = "KORDI_DESKTOP_UPDATE_RELEASE_API_URL";
const DESKTOP_UPDATE_USER_AGENT: &str = "kordi-cloud-server-desktop-updater";

pub fn routes() -> Router {
    Router::new().route(
        "/api/desktop-updates/:target/:arch/:current_version",
        get(desktop_update_manifest),
    )
}

async fn desktop_update_manifest(
    Path((target, arch, current_version)): Path<(String, String, String)>,
) -> Response {
    let release_api_url = std::env::var(DESKTOP_UPDATE_RELEASE_API_URL_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_DESKTOP_UPDATE_RELEASE_API_URL.to_string());

    let client = reqwest::Client::new();
    let Ok(response) = client
        .get(release_api_url)
        .header(USER_AGENT, DESKTOP_UPDATE_USER_AGENT)
        .send()
        .await
    else {
        return StatusCode::NO_CONTENT.into_response();
    };
    if !response.status().is_success() {
        return StatusCode::NO_CONTENT.into_response();
    }
    let Ok(release) = response.json::<serde_json::Value>().await else {
        return StatusCode::NO_CONTENT.into_response();
    };
    let Some(candidate) = desktop_update_manifest_candidate(&release, &target, &arch, &current_version)
    else {
        return StatusCode::NO_CONTENT.into_response();
    };
    let Ok(signature_response) = client
        .get(&candidate.signature_url)
        .header(USER_AGENT, DESKTOP_UPDATE_USER_AGENT)
        .send()
        .await
    else {
        return StatusCode::NO_CONTENT.into_response();
    };
    if !signature_response.status().is_success() {
        return StatusCode::NO_CONTENT.into_response();
    }
    let Ok(signature) = signature_response.text().await else {
        return StatusCode::NO_CONTENT.into_response();
    };
    if signature.trim().is_empty() {
        return StatusCode::NO_CONTENT.into_response();
    }

    axum::Json(candidate.into_manifest(signature.trim())).into_response()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ReleaseAsset {
    name: String,
    url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DesktopUpdateManifestCandidate {
    version: String,
    notes: String,
    pub_date: String,
    url: String,
    signature_url: String,
}

impl DesktopUpdateManifestCandidate {
    fn into_manifest(self, signature: &str) -> serde_json::Value {
        serde_json::json!({
            "version": self.version,
            "notes": self.notes,
            "pub_date": self.pub_date,
            "url": self.url,
            "signature": signature,
        })
    }
}

fn desktop_update_manifest_candidate(
    release: &serde_json::Value,
    target: &str,
    arch: &str,
    current_version: &str,
) -> Option<DesktopUpdateManifestCandidate> {
    let version = release
        .get("tag_name")
        .and_then(|value| value.as_str())
        .or_else(|| release.get("name").and_then(|value| value.as_str()))
        .map(normalize_version)?;
    if version.is_empty() || version_matches_current(&version, current_version) {
        return None;
    }

    let assets = release
        .get("assets")
        .and_then(|value| value.as_array())?
        .iter()
        .filter_map(release_asset)
        .collect::<Vec<_>>();
    let update_asset = assets
        .iter()
        .find(|asset| is_matching_update_asset(&asset.name, target, arch))?;
    let signature_asset = matching_signature_asset(&assets, &update_asset.name)?;

    Some(DesktopUpdateManifestCandidate {
        version,
        notes: release
            .get("body")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string(),
        pub_date: release
            .get("published_at")
            .and_then(|value| value.as_str())
            .or_else(|| release.get("created_at").and_then(|value| value.as_str()))
            .unwrap_or_default()
            .to_string(),
        url: update_asset.url.clone(),
        signature_url: signature_asset.url.clone(),
    })
}

fn release_asset(value: &serde_json::Value) -> Option<ReleaseAsset> {
    Some(ReleaseAsset {
        name: value.get("name")?.as_str()?.to_string(),
        url: value.get("browser_download_url")?.as_str()?.to_string(),
    })
}

fn normalize_version(value: &str) -> String {
    value.trim().trim_start_matches('v').trim().to_string()
}

fn version_matches_current(version: &str, current_version: &str) -> bool {
    normalize_version(version) == normalize_version(current_version)
}

fn matching_signature_asset<'a>(assets: &'a [ReleaseAsset], update_asset_name: &str) -> Option<&'a ReleaseAsset> {
    let expected = format!("{update_asset_name}.sig");
    assets.iter().find(|asset| asset.name.eq_ignore_ascii_case(&expected))
}

fn is_matching_update_asset(name: &str, target: &str, arch: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".sig") || lower.ends_with(".dmg") || !is_updater_archive(&lower) {
        return false;
    }
    contains_any(&lower, arch_aliases(arch)) && contains_any(&lower, target_aliases(target))
}

fn is_updater_archive(lower_name: &str) -> bool {
    lower_name.ends_with(".app.tar.gz")
        || lower_name.ends_with(".appimage.tar.gz")
        || lower_name.ends_with(".msi.zip")
        || lower_name.ends_with(".nsis.zip")
        || lower_name.ends_with(".tar.gz")
        || lower_name.ends_with(".zip")
}

fn arch_aliases(arch: &str) -> &'static [&'static str] {
    match arch {
        "aarch64" | "arm64" => &["aarch64", "arm64"],
        "x86_64" | "amd64" | "x64" => &["x86_64", "x64", "amd64"],
        _ => &[],
    }
}

fn target_aliases(target: &str) -> &'static [&'static str] {
    match target {
        "darwin" => &["darwin", "macos", "mac", "apple", ".app.tar.gz"],
        "linux" => &["linux", ".appimage"],
        "windows" => &["windows", "win32", "win", ".msi.zip", ".nsis.zip"],
        _ => &[],
    }
}

fn contains_any(value: &str, aliases: &[&str]) -> bool {
    !aliases.is_empty() && aliases.iter().any(|alias| value.contains(alias))
}

#[cfg(test)]
mod tests {
    use super::{desktop_update_manifest_candidate, is_matching_update_asset};

    #[test]
    fn desktop_update_manifest_is_quiet_when_release_has_no_matching_asset() {
        let release = serde_json::json!({
            "tag_name": "v0.0.1-beta.4",
            "published_at": "2026-06-04T00:00:00Z",
            "assets": []
        });

        assert!(desktop_update_manifest_candidate(&release, "darwin", "aarch64", "0.0.1-beta.3").is_none());
    }

    #[test]
    fn desktop_update_manifest_is_quiet_when_release_matches_current_version() {
        let release = serde_json::json!({
            "tag_name": "v0.0.1-beta.4",
            "published_at": "2026-06-04T00:00:00Z",
            "assets": [{
                "name": "Kordi_0.0.1-beta.4_aarch64.app.tar.gz",
                "browser_download_url": "https://github.com/Kordi-AI/Kordi/releases/download/v0.0.1-beta.4/Kordi_0.0.1-beta.4_aarch64.app.tar.gz"
            }, {
                "name": "Kordi_0.0.1-beta.4_aarch64.app.tar.gz.sig",
                "browser_download_url": "https://github.com/Kordi-AI/Kordi/releases/download/v0.0.1-beta.4/Kordi_0.0.1-beta.4_aarch64.app.tar.gz.sig"
            }]
        });

        assert!(desktop_update_manifest_candidate(&release, "darwin", "aarch64", "v0.0.1-beta.4").is_none());
    }

    #[test]
    fn desktop_update_manifest_uses_release_asset_and_companion_signature() {
        let release = serde_json::json!({
            "tag_name": "v0.0.1-beta.4",
            "body": "Bug fixes",
            "published_at": "2026-06-04T00:00:00Z",
            "assets": [{
                "name": "Kordi_0.0.1-beta.4_aarch64.dmg",
                "browser_download_url": "https://github.com/Kordi-AI/Kordi/releases/download/v0.0.1-beta.4/Kordi_0.0.1-beta.4_aarch64.dmg"
            }, {
                "name": "Kordi_0.0.1-beta.4_aarch64.app.tar.gz",
                "browser_download_url": "https://github.com/Kordi-AI/Kordi/releases/download/v0.0.1-beta.4/Kordi_0.0.1-beta.4_aarch64.app.tar.gz"
            }, {
                "name": "Kordi_0.0.1-beta.4_aarch64.app.tar.gz.sig",
                "browser_download_url": "https://github.com/Kordi-AI/Kordi/releases/download/v0.0.1-beta.4/Kordi_0.0.1-beta.4_aarch64.app.tar.gz.sig"
            }]
        });

        let candidate = desktop_update_manifest_candidate(&release, "darwin", "aarch64", "0.0.1-beta.3").unwrap();
        assert_eq!(candidate.version, "0.0.1-beta.4");
        assert_eq!(candidate.notes, "Bug fixes");
        assert_eq!(candidate.pub_date, "2026-06-04T00:00:00Z");
        assert!(candidate.url.ends_with(".app.tar.gz"));
        assert!(candidate.signature_url.ends_with(".app.tar.gz.sig"));

        let manifest = candidate.into_manifest("signed-release");
        assert_eq!(manifest["version"], "0.0.1-beta.4");
        assert_eq!(manifest["signature"], "signed-release");
        assert!(manifest["url"].as_str().unwrap().contains("github.com/Kordi-AI/Kordi/releases"));
    }

    #[test]
    fn update_asset_matching_requires_target_arch_and_updater_archive() {
        assert!(is_matching_update_asset(
            "Kordi_0.0.1-beta.4_aarch64.app.tar.gz",
            "darwin",
            "aarch64"
        ));
        assert!(!is_matching_update_asset(
            "Kordi_0.0.1-beta.4_aarch64.dmg",
            "darwin",
            "aarch64"
        ));
        assert!(!is_matching_update_asset(
            "Kordi_0.0.1-beta.4_x64.app.tar.gz",
            "darwin",
            "aarch64"
        ));
    }
}

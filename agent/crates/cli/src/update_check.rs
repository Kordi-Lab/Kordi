use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use kordi_core::settings::Settings;
use kordi_tui::tui::{TuiCommand, TuiNoteLevel};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

const DEFAULT_RELEASE_VERSION_URL: &str = "https://coordinar.io/updates/releases/version";
const DEFAULT_NPM_PACKAGE: Option<&str> = None;
const DEFAULT_CHANGELOG_URL: Option<&str> = Some("https://github.com/Kordi-AI/Kordi/releases");
const DEFAULT_INSTALL_COMMAND: Option<&str> = None;
const REQUEST_TIMEOUT: Duration = Duration::from_millis(1500);

#[derive(Clone, Debug, PartialEq, Eq)]
struct UpdateCheckConfig {
    package_name: String,
    release_version_url: Option<String>,
    current_version: String,
    install_command: String,
    changelog_url: Option<String>,
    cache_ttl: Duration,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct UpdateNotice {
    pub latest_version: String,
    pub install_command: String,
    pub changelog_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct NpmLatestResponse {
    version: String,
}

#[derive(Debug, Deserialize)]
struct HostedReleaseVersionResponse {
    #[serde(default, alias = "latestVersion", alias = "latest_version")]
    version: String,
    #[serde(default, alias = "installCommand", alias = "install_command")]
    install_command: Option<String>,
    #[serde(
        default,
        alias = "changelogUrl",
        alias = "changelog_url",
        alias = "releaseNotesUrl"
    )]
    changelog_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct HostedReleaseVersion {
    latest_version: String,
    install_command: Option<String>,
    changelog_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum UpdateCheckOutcome {
    Disabled,
    UpToDate,
    UpdateAvailable(UpdateNotice),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct UpdateCheckCache {
    package_name: String,
    current_version: String,
    checked_at_unix_secs: u64,
    notice: Option<UpdateNotice>,
}

pub(crate) fn spawn_update_check_notice_task(
    command_tx: mpsc::UnboundedSender<TuiCommand>,
    cwd: PathBuf,
) {
    tokio::spawn(async move {
        match check_for_updates(false, &cwd).await {
            Ok(UpdateCheckOutcome::UpdateAvailable(notice)) => {
                let _ = command_tx.send(TuiCommand::PushNote {
                    level: TuiNoteLevel::Highlight,
                    text: build_update_available_note(&notice),
                });
            }
            Ok(UpdateCheckOutcome::Disabled | UpdateCheckOutcome::UpToDate) => {}
            Err(err) => tracing::debug!("update check skipped: {err}"),
        }
    });
}

pub(crate) async fn check_for_updates(
    force_refresh: bool,
    cwd: &Path,
) -> anyhow::Result<UpdateCheckOutcome> {
    let Some(config) = load_config(cwd) else {
        return Ok(UpdateCheckOutcome::Disabled);
    };

    if !force_refresh && let Some(cached) = load_cached_outcome(&config)? {
        return Ok(cached);
    }

    let notice = fetch_update_notice(&config).await?;
    store_cached_outcome(&config, notice.as_ref())?;
    Ok(match notice {
        Some(notice) => UpdateCheckOutcome::UpdateAvailable(notice),
        None => UpdateCheckOutcome::UpToDate,
    })
}

fn explicit_install_command_override() -> Option<String> {
    std::env::var("KORDI_UPDATE_CHECK_INSTALL")
        .ok()
        .filter(|cmd| !cmd.trim().is_empty())
}

fn detect_hosted_install_command() -> String {
    explicit_install_command_override().unwrap_or_else(|| {
        "Download the latest Kordi release from https://github.com/Kordi-AI/Kordi/releases"
            .to_string()
    })
}

fn detect_install_command(package_name: &str) -> String {
    if let Some(cmd) = explicit_install_command_override() {
        return cmd;
    }
    if std::env::var("KORDI_NPM_WRAPPER_ACTIVE").ok().as_deref() == Some("1") {
        return format!("npm install -g {package_name}@latest");
    }
    if let Ok(exe) = std::env::current_exe() {
        let exe = exe.display().to_string().to_ascii_lowercase();
        if exe.contains("node_modules") || exe.contains("homebrew") || exe.contains("npm") {
            return format!("npm install -g {package_name}@latest");
        }
        if exe.contains(".cargo") || exe.contains("cargo") {
            return "cargo install --git https://github.com/Kordi-AI/Kordi.git kordi-cli --force"
                .to_string();
        }
    }
    DEFAULT_INSTALL_COMMAND
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("npm install -g {package_name}@latest"))
}

fn load_config(cwd: &Path) -> Option<UpdateCheckConfig> {
    let settings = Settings::load_merged(cwd);
    if !settings.update_check.enabled {
        return None;
    }

    let explicit_package_name = std::env::var("KORDI_UPDATE_CHECK_PACKAGE")
        .ok()
        .or_else(|| DEFAULT_NPM_PACKAGE.map(ToString::to_string));
    let release_version_url = explicit_package_name.is_none().then(|| {
        std::env::var("KORDI_UPDATE_CHECK_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_RELEASE_VERSION_URL.to_string())
    });
    let package_name = explicit_package_name.or_else(|| release_version_url.clone())?;
    let install_command = if release_version_url.is_some() {
        detect_hosted_install_command()
    } else {
        detect_install_command(&package_name)
    };
    let changelog_url = std::env::var("KORDI_UPDATE_CHECK_CHANGELOG")
        .ok()
        .or_else(|| DEFAULT_CHANGELOG_URL.map(ToString::to_string));

    let ttl_hours = std::env::var("KORDI_UPDATE_CHECK_TTL_HOURS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(settings.update_check.ttl_hours);

    Some(UpdateCheckConfig {
        package_name,
        release_version_url,
        current_version: env!("CARGO_PKG_VERSION").to_string(),
        install_command,
        changelog_url,
        cache_ttl: Duration::from_secs(ttl_hours.saturating_mul(60 * 60)),
    })
}

fn load_cached_outcome(config: &UpdateCheckConfig) -> anyhow::Result<Option<UpdateCheckOutcome>> {
    load_cached_outcome_from_path(config, &cache_file_path())
}

fn load_cached_outcome_from_path(
    config: &UpdateCheckConfig,
    path: &std::path::Path,
) -> anyhow::Result<Option<UpdateCheckOutcome>> {
    let Ok(content) = fs::read_to_string(path) else {
        return Ok(None);
    };
    let Ok(cache) = serde_json::from_str::<UpdateCheckCache>(&content) else {
        return Ok(None);
    };
    if cache.package_name != config.package_name || cache.current_version != config.current_version
    {
        return Ok(None);
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    if now.saturating_sub(cache.checked_at_unix_secs) > config.cache_ttl.as_secs() {
        return Ok(None);
    }

    Ok(Some(match cache.notice {
        Some(notice) => UpdateCheckOutcome::UpdateAvailable(notice),
        None => UpdateCheckOutcome::UpToDate,
    }))
}

fn store_cached_outcome(
    config: &UpdateCheckConfig,
    notice: Option<&UpdateNotice>,
) -> anyhow::Result<()> {
    store_cached_outcome_to_path(config, notice, &cache_file_path())
}

fn store_cached_outcome_to_path(
    config: &UpdateCheckConfig,
    notice: Option<&UpdateNotice>,
    path: &std::path::Path,
) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let cache = UpdateCheckCache {
        package_name: config.package_name.clone(),
        current_version: config.current_version.clone(),
        checked_at_unix_secs: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        notice: notice.cloned(),
    };
    fs::write(path, serde_json::to_vec_pretty(&cache)?)?;
    Ok(())
}

fn cache_file_path() -> PathBuf {
    if let Ok(path) = std::env::var("KORDI_UPDATE_CHECK_CACHE_PATH") {
        return PathBuf::from(path);
    }
    let settings = Settings::load_global();
    kordi_core::config::update_check_cache_path(&settings.storage)
}

async fn fetch_update_notice(config: &UpdateCheckConfig) -> anyhow::Result<Option<UpdateNotice>> {
    if let Some(url) = &config.release_version_url {
        return fetch_hosted_update_notice(config, url).await;
    }

    let encoded_package = encode_registry_package_name(&config.package_name);
    let url = format!("https://registry.npmjs.org/{encoded_package}/latest");
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()?;
    let response = client.get(url).send().await?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }

    let response = response.error_for_status()?;
    let latest: NpmLatestResponse = response.json().await?;
    update_notice_from_latest_version(config, latest.version, None, None)
}

async fn fetch_hosted_update_notice(
    config: &UpdateCheckConfig,
    url: &str,
) -> anyhow::Result<Option<UpdateNotice>> {
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()?;
    let response = client.get(url).send().await?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }

    let body = response.error_for_status()?.text().await?;
    let latest = parse_release_version_response(&body)?;
    update_notice_from_latest_version(
        config,
        latest.latest_version,
        latest.install_command,
        latest.changelog_url,
    )
}

fn update_notice_from_latest_version(
    config: &UpdateCheckConfig,
    latest_version: String,
    install_command: Option<String>,
    changelog_url: Option<String>,
) -> anyhow::Result<Option<UpdateNotice>> {
    if is_newer_version(&latest_version, &config.current_version) {
        Ok(Some(UpdateNotice {
            latest_version,
            install_command: install_command.unwrap_or_else(|| config.install_command.clone()),
            changelog_url: changelog_url.or_else(|| config.changelog_url.clone()),
        }))
    } else {
        Ok(None)
    }
}

fn parse_release_version_response(body: &str) -> anyhow::Result<HostedReleaseVersion> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        anyhow::bail!("empty update version response");
    }

    if let Ok(response) = serde_json::from_str::<HostedReleaseVersionResponse>(trimmed) {
        let latest_version = response.version.trim().to_string();
        if latest_version.is_empty() {
            anyhow::bail!("update version response did not include a version");
        }
        return Ok(HostedReleaseVersion {
            latest_version,
            install_command: response.install_command,
            changelog_url: response.changelog_url,
        });
    }

    let latest_version = trimmed.trim_matches('"').trim().to_string();
    if latest_version.is_empty() {
        anyhow::bail!("update version response did not include a version");
    }
    Ok(HostedReleaseVersion {
        latest_version,
        install_command: None,
        changelog_url: None,
    })
}

fn encode_registry_package_name(package_name: &str) -> String {
    package_name.replace('/', "%2F")
}

fn parse_version_core(version: &str) -> Vec<u64> {
    let core = version
        .split_once('-')
        .map(|(core, _)| core)
        .unwrap_or(version);
    let core = core.split_once('+').map(|(core, _)| core).unwrap_or(core);
    core.split('.')
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect()
}

fn is_prerelease(version: &str) -> bool {
    version.contains('-')
}

fn is_newer_version(candidate: &str, current: &str) -> bool {
    let lhs = parse_version_core(candidate);
    let rhs = parse_version_core(current);
    let len = lhs.len().max(rhs.len());

    for index in 0..len {
        let left = lhs.get(index).copied().unwrap_or(0);
        let right = rhs.get(index).copied().unwrap_or(0);
        if left != right {
            return left > right;
        }
    }

    !is_prerelease(candidate) && is_prerelease(current)
}

pub(crate) fn build_update_available_note(notice: &UpdateNotice) -> String {
    let mut lines = vec![format!(
        "kordi update available: {} • use {}",
        notice.latest_version, notice.install_command
    )];
    if let Some(changelog_url) = &notice.changelog_url {
        lines.push(format!("release notes: {changelog_url}"));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;

    use super::{
        DEFAULT_RELEASE_VERSION_URL, UpdateCheckConfig, UpdateCheckOutcome, UpdateNotice,
        build_update_available_note, detect_install_command, is_newer_version,
        load_cached_outcome_from_path, load_config, parse_release_version_response,
        store_cached_outcome_to_path,
    };

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    struct EnvGuard {
        key: &'static str,
        original: Option<String>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let original = std::env::var(key).ok();
            unsafe { std::env::set_var(key, value) };
            Self { key, original }
        }

        fn remove(key: &'static str) -> Self {
            let original = std::env::var(key).ok();
            unsafe { std::env::remove_var(key) };
            Self { key, original }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            if let Some(value) = &self.original {
                unsafe { std::env::set_var(self.key, value) };
            } else {
                unsafe { std::env::remove_var(self.key) };
            }
        }
    }

    #[test]
    fn load_config_uses_hosted_coordinar_release_endpoint_by_default() {
        let _guard = env_lock().lock().unwrap();
        let home = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let _home = EnvGuard::set("HOME", home.path().to_str().unwrap());
        let _package = EnvGuard::remove("KORDI_UPDATE_CHECK_PACKAGE");
        let _endpoint = EnvGuard::remove("KORDI_UPDATE_CHECK_URL");
        let _changelog = EnvGuard::remove("KORDI_UPDATE_CHECK_CHANGELOG");
        let _ttl = EnvGuard::remove("KORDI_UPDATE_CHECK_TTL_HOURS");
        let _cache = EnvGuard::remove("KORDI_UPDATE_CHECK_CACHE_PATH");
        let _install = EnvGuard::remove("KORDI_UPDATE_CHECK_INSTALL");
        let _wrapper = EnvGuard::remove("KORDI_NPM_WRAPPER_ACTIVE");

        let config =
            load_config(cwd.path()).expect("hosted update check should be configured by default");

        assert_eq!(
            config.release_version_url.as_deref(),
            Some(DEFAULT_RELEASE_VERSION_URL)
        );
        assert_eq!(config.package_name, DEFAULT_RELEASE_VERSION_URL);
    }

    #[test]
    fn hosted_update_config_uses_release_download_install_text() {
        let _guard = env_lock().lock().unwrap();
        let home = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let _home = EnvGuard::set("HOME", home.path().to_str().unwrap());
        let _package = EnvGuard::remove("KORDI_UPDATE_CHECK_PACKAGE");
        let _endpoint = EnvGuard::remove("KORDI_UPDATE_CHECK_URL");
        let _install = EnvGuard::remove("KORDI_UPDATE_CHECK_INSTALL");
        let _wrapper = EnvGuard::remove("KORDI_NPM_WRAPPER_ACTIVE");

        let config =
            load_config(cwd.path()).expect("hosted update check should be configured by default");

        assert_eq!(
            config.install_command,
            "Download the latest Kordi release from https://github.com/Kordi-AI/Kordi/releases"
        );
    }

    #[test]
    fn parses_hosted_release_version_response_shapes() {
        let object = parse_release_version_response(r#"{ "version": "0.0.1-beta.6" }"#).unwrap();
        assert_eq!(object.latest_version, "0.0.1-beta.6");

        let camel = parse_release_version_response(
            r#"{ "latestVersion": "0.0.1-beta.7", "changelogUrl": "https://coordinar.io/releases" }"#,
        )
        .unwrap();
        assert_eq!(camel.latest_version, "0.0.1-beta.7");
        assert_eq!(
            camel.changelog_url.as_deref(),
            Some("https://coordinar.io/releases")
        );

        let plain = parse_release_version_response("0.0.1-beta.8").unwrap();
        assert_eq!(plain.latest_version, "0.0.1-beta.8");
    }

    #[test]
    fn compares_semver_like_versions() {
        assert!(is_newer_version("0.65.0", "0.64.9"));
        assert!(is_newer_version("1.0.0", "0.99.0"));
        assert!(!is_newer_version("0.65.0", "0.65.0"));
        assert!(!is_newer_version("0.64.9", "0.65.0"));
        assert!(is_newer_version("0.65.0", "0.65.0-beta.1"));
    }

    #[test]
    fn formats_update_available_note() {
        let text = build_update_available_note(&UpdateNotice {
            latest_version: "0.65.0".to_string(),
            install_command:
                "cargo install --git https://github.com/Kordi-AI/Kordi.git kordi-cli --force"
                    .to_string(),
            changelog_url: Some("https://example.com/kordi/changelog".to_string()),
        });

        assert!(text.contains("kordi update available: 0.65.0"));
        assert!(text.contains(
            "cargo install --git https://github.com/Kordi-AI/Kordi.git kordi-cli --force"
        ));
        assert!(text.contains("release notes: https://example.com/kordi/changelog"));
    }

    #[test]
    fn cache_round_trip_preserves_available_update() {
        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("update-check.json");
        let config = UpdateCheckConfig {
            package_name: "npm:demo".to_string(),
            release_version_url: None,
            current_version: "0.1.0".to_string(),
            install_command: "npm install -g demo".to_string(),
            changelog_url: None,
            cache_ttl: Duration::from_secs(60 * 60 * 24),
        };
        let notice = UpdateNotice {
            latest_version: "0.2.0".to_string(),
            install_command: "npm install -g demo".to_string(),
            changelog_url: None,
        };

        store_cached_outcome_to_path(&config, Some(&notice), &cache_path).unwrap();
        let loaded = load_cached_outcome_from_path(&config, &cache_path).unwrap();
        assert_eq!(loaded, Some(UpdateCheckOutcome::UpdateAvailable(notice)));
    }

    #[test]
    fn expired_cache_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("update-check.json");
        let config = UpdateCheckConfig {
            package_name: "npm:demo".to_string(),
            release_version_url: None,
            current_version: "0.1.0".to_string(),
            install_command: "npm install -g demo".to_string(),
            changelog_url: None,
            cache_ttl: Duration::from_secs(60),
        };
        let cache = super::UpdateCheckCache {
            package_name: config.package_name.clone(),
            current_version: config.current_version.clone(),
            checked_at_unix_secs: 0,
            notice: Some(UpdateNotice {
                latest_version: "0.2.0".to_string(),
                install_command: "npm install -g demo".to_string(),
                changelog_url: None,
            }),
        };

        std::fs::write(&cache_path, serde_json::to_vec_pretty(&cache).unwrap()).unwrap();
        let loaded = load_cached_outcome_from_path(&config, &cache_path).unwrap();
        assert_eq!(loaded, None);
    }

    #[test]
    fn cache_is_ignored_when_package_name_changes() {
        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("update-check.json");
        let written_config = UpdateCheckConfig {
            package_name: "npm:demo".to_string(),
            release_version_url: None,
            current_version: "0.1.0".to_string(),
            install_command: "npm install -g demo".to_string(),
            changelog_url: None,
            cache_ttl: Duration::from_secs(60 * 60 * 24),
        };
        let read_config = UpdateCheckConfig {
            package_name: "npm:other".to_string(),
            ..written_config.clone()
        };

        store_cached_outcome_to_path(&written_config, None, &cache_path).unwrap();
        let loaded = load_cached_outcome_from_path(&read_config, &cache_path).unwrap();
        assert_eq!(loaded, None);
    }

    #[test]
    fn cache_is_ignored_when_current_version_changes() {
        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("update-check.json");
        let written_config = UpdateCheckConfig {
            package_name: "npm:demo".to_string(),
            release_version_url: None,
            current_version: "0.1.0".to_string(),
            install_command: "npm install -g demo".to_string(),
            changelog_url: None,
            cache_ttl: Duration::from_secs(60 * 60 * 24),
        };
        let read_config = UpdateCheckConfig {
            current_version: "0.2.0".to_string(),
            ..written_config.clone()
        };

        store_cached_outcome_to_path(&written_config, None, &cache_path).unwrap();
        let loaded = load_cached_outcome_from_path(&read_config, &cache_path).unwrap();
        assert_eq!(loaded, None);
    }

    #[test]
    fn detect_install_command_prefers_explicit_env_override() {
        let _guard = env_lock().lock().unwrap();
        let _install = EnvGuard::set("KORDI_UPDATE_CHECK_INSTALL", "custom install cmd");
        let _wrapper = EnvGuard::remove("KORDI_NPM_WRAPPER_ACTIVE");

        assert_eq!(detect_install_command("demo"), "custom install cmd");
    }

    #[test]
    fn load_config_returns_none_when_update_check_is_disabled_in_project_settings() {
        let _guard = env_lock().lock().unwrap();
        let home = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let _home = EnvGuard::set("HOME", home.path().to_str().unwrap());
        let _package = EnvGuard::remove("KORDI_UPDATE_CHECK_PACKAGE");
        let _changelog = EnvGuard::remove("KORDI_UPDATE_CHECK_CHANGELOG");
        let _ttl = EnvGuard::remove("KORDI_UPDATE_CHECK_TTL_HOURS");
        let _cache = EnvGuard::remove("KORDI_UPDATE_CHECK_CACHE_PATH");
        let _install = EnvGuard::remove("KORDI_UPDATE_CHECK_INSTALL");
        let _wrapper = EnvGuard::remove("KORDI_NPM_WRAPPER_ACTIVE");

        let project_settings_dir = cwd.path().join(".kordi");
        std::fs::create_dir_all(&project_settings_dir).unwrap();
        std::fs::write(
            project_settings_dir.join("settings.json"),
            r#"{ "updateCheck": { "enabled": false } }"#,
        )
        .unwrap();

        assert!(load_config(cwd.path()).is_none());
    }
}

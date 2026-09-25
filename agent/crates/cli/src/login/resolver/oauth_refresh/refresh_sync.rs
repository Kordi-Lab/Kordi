//! Synchronous OAuth refresh coordination: one cross-process refresh lock,
//! reuse of a token another process already refreshed, and persistence of the
//! refreshed credential to its provider or stored profile.

use super::*;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, Instant};

pub(super) fn try_refresh_sync(provider: &str, refresh_token: &str) -> Option<String> {
    let _lock = acquire_auth_refresh_lock()?;
    if let Some(credential) = fresh_oauth_credential_for_provider(provider) {
        return Some(credential);
    }

    let rt = match tokio::runtime::Handle::try_current() {
        Ok(_handle) => {
            let provider = provider.to_string();
            let refresh_token = refresh_token.to_string();
            let result = std::thread::spawn(move || {
                let rt = tokio::runtime::Runtime::new().ok()?;
                rt.block_on(do_refresh(&provider, &refresh_token, None))
            })
            .join()
            .ok()
            .flatten();
            return result;
        }
        Err(_) => tokio::runtime::Runtime::new().ok()?,
    };
    rt.block_on(do_refresh(provider, refresh_token, None))
}

pub(super) fn try_refresh_profile_sync(
    provider: &str,
    profile_id: &str,
    refresh_token: &str,
) -> Option<String> {
    let _lock = acquire_auth_refresh_lock()?;
    if let Some(credential) = fresh_oauth_credential_for_profile(provider, profile_id) {
        return Some(credential);
    }
    let provider_owned = provider.to_string();
    let profile_id_owned = profile_id.to_string();
    let refresh_token_owned = refresh_token.to_string();
    match tokio::runtime::Handle::try_current() {
        Ok(_) => std::thread::spawn(move || {
            let runtime = tokio::runtime::Runtime::new().ok()?;
            runtime.block_on(do_refresh(
                &provider_owned,
                &refresh_token_owned,
                Some(&profile_id_owned),
            ))
        })
        .join()
        .ok()
        .flatten(),
        Err(_) => tokio::runtime::Runtime::new().ok()?.block_on(do_refresh(
            provider,
            refresh_token,
            Some(profile_id),
        )),
    }
}

struct AuthRefreshLock {
    path: PathBuf,
    _file: File,
}

impl Drop for AuthRefreshLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn acquire_auth_refresh_lock() -> Option<AuthRefreshLock> {
    let path = auth_refresh_lock_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok()?;
    }

    let started = Instant::now();
    loop {
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                let _ = writeln!(
                    file,
                    "pid={} acquired_at_ms={}",
                    std::process::id(),
                    chrono::Utc::now().timestamp_millis()
                );
                return Some(AuthRefreshLock { path, _file: file });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if auth_refresh_lock_is_stale(&path) {
                    let _ = std::fs::remove_file(&path);
                    continue;
                }
                if started.elapsed() >= Duration::from_secs(70) {
                    return None;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(_) => return None,
        }
    }
}

fn auth_refresh_lock_path() -> PathBuf {
    let path = auth_path();
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("auth.json");
    path.with_file_name(format!(".{file_name}.refresh.lock"))
}

fn auth_refresh_lock_is_stale(path: &std::path::Path) -> bool {
    path.metadata()
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|elapsed| elapsed > Duration::from_secs(120))
}

fn fresh_oauth_credential_for_provider(provider: &str) -> Option<String> {
    let provider = match provider {
        "anthropic-oauth" => "anthropic",
        other => other,
    };
    if !matches!(provider, "anthropic" | "openai" | "openai-codex") {
        return None;
    }

    let store = load_auth();
    let profile = stored_auth_profile_for_method(&store, provider, ProviderAuthMethod::OAuth)?;
    let AuthEntry::OAuth {
        access, expires, ..
    } = &profile.entry
    else {
        return None;
    };
    let now_ms = chrono::Utc::now().timestamp_millis();
    (*expires > now_ms + 60_000 && !access.trim().is_empty()).then(|| access.clone())
}

/// A token another process already refreshed for this stored profile. The
/// caller passes the storage key (`anthropic-oauth`), while Anthropic profiles
/// are stored under `anthropic`.
fn fresh_oauth_credential_for_profile(provider: &str, profile_id: &str) -> Option<String> {
    let provider = match provider {
        "anthropic-oauth" => "anthropic",
        other => other,
    };
    let store = load_auth();
    let profile = stored_auth_profile_by_id(&store, provider, profile_id)?;
    let AuthEntry::OAuth {
        access, expires, ..
    } = &profile.entry
    else {
        return None;
    };
    let now_ms = chrono::Utc::now().timestamp_millis();
    (*expires > now_ms + 60_000 && !access.trim().is_empty()).then(|| access.clone())
}

async fn do_refresh(
    provider: &str,
    refresh_token: &str,
    profile_id: Option<&str>,
) -> Option<String> {
    use crate::oauth;

    let provider = match provider {
        "anthropic-oauth" => "anthropic",
        other => other,
    };

    let creds = match provider {
        "anthropic" => oauth::anthropic::refresh_anthropic_token(refresh_token)
            .await
            .ok()?,
        "openai" | "openai-codex" => oauth::openai_codex::refresh_openai_codex_token(refresh_token)
            .await
            .ok()?,
        "github-copilot" => oauth::github_copilot::refresh_github_copilot_token(
            refresh_token,
            &github_copilot_domain().unwrap_or_else(|| "github.com".to_string()),
        )
        .await
        .ok()?,
        _ => return None,
    };

    // The provider already rotated the refresh token, so the new access token
    // is returned even when the auth file cannot be written.
    let _ = if let Some(profile_id) = profile_id {
        save_refreshed_oauth_profile(provider, profile_id, &creds)
    } else {
        save_oauth_credentials(provider, &creds)
    };
    if provider == "github-copilot" {
        creds
            .extra
            .get("copilot_token")
            .and_then(|value| value.as_str())
            .map(ToString::to_string)
            .or(Some(creds.access))
    } else {
        Some(creds.access)
    }
}

#[cfg(test)]
mod tests {
    use super::fresh_oauth_credential_for_profile;
    use crate::login::ProviderAuthMethod;
    use crate::login::store::{AuthEntry, AuthProfile, AuthStore, save_auth};

    struct EnvVarGuard {
        key: &'static str,
        old: Option<std::ffi::OsString>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: &std::path::Path) -> Self {
            let old = std::env::var_os(key);
            unsafe { std::env::set_var(key, value) };
            Self { key, old }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            match self.old.take() {
                Some(value) => unsafe { std::env::set_var(self.key, value) },
                None => unsafe { std::env::remove_var(self.key) },
            }
        }
    }

    #[test]
    fn an_anthropic_profile_refreshed_elsewhere_is_found_by_its_storage_key() {
        let _lock = crate::login::auth_test_env_lock().lock().unwrap();
        let home = tempfile::tempdir().expect("home tempdir");
        let _auth_path = EnvVarGuard::set("KORDI_AUTH_PATH", &home.path().join("auth.json"));
        let mut store = AuthStore::default();
        store.profiles.insert(
            "anthropic".to_string(),
            vec![AuthProfile {
                id: "work".to_string(),
                method: ProviderAuthMethod::OAuth,
                created_at_ms: Some(1),
                updated_at_ms: Some(1),
                entry: AuthEntry::OAuth {
                    access: "refreshed-by-another-process".to_string(),
                    refresh: "rotated-refresh".to_string(),
                    expires: chrono::Utc::now().timestamp_millis() + 3_600_000,
                    extra: serde_json::json!({}),
                },
            }],
        );
        save_auth(&store).expect("save auth store");

        assert_eq!(
            fresh_oauth_credential_for_profile("anthropic-oauth", "work").as_deref(),
            Some("refreshed-by-another-process")
        );
        assert_eq!(
            fresh_oauth_credential_for_profile("anthropic", "work").as_deref(),
            Some("refreshed-by-another-process")
        );
        assert_eq!(
            fresh_oauth_credential_for_profile("anthropic-oauth", "missing"),
            None
        );
    }
}

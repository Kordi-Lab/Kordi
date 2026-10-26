//! An agent's personal session opened on this Mac before its first local turn
//! is an in-memory runtime copy with no stored row. A refresh for another
//! session can unload that copy between opening the session and building its
//! chat state; the state build must open it again, not resume a row that does
//! not exist ("No session matching"). Once a turn stores it, it resumes after
//! a restart like any chat.

use super::{
    active_runtime_handle, ensure_loaded_or_create_explicit_session, ensure_loaded_session,
    is_missing_session_error, resume_desktop_runtime,
};
use crate::chat::DesktopChatManager;

struct EnvGuard(Vec<(&'static str, Option<std::ffi::OsString>)>);

impl EnvGuard {
    fn set(values: &[(&'static str, std::ffi::OsString)]) -> Self {
        let previous = values
            .iter()
            .map(|(key, value)| {
                let previous = std::env::var_os(key);
                std::env::set_var(key, value);
                (*key, previous)
            })
            .collect();
        Self(previous)
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (key, previous) in &self.0 {
            match previous {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unloaded_personal_session_opens_again_and_survives_a_restart() {
    let storage = crate::test_support::ScopedKordiStorageRoot::new("personal-session-reload");
    let root = storage.root().to_path_buf();
    let home = root.join("home");
    let app = root.join("app");
    let cwd = root.join("chat");
    for dir in [&home, &app, &cwd] {
        std::fs::create_dir_all(dir).unwrap();
    }
    let _env = EnvGuard::set(&[
        ("HOME", home.into_os_string()),
        ("APP_DATA_DIR", app.into_os_string()),
        ("VITE_KORDI_CLOUD_API_BASE", "http://127.0.0.1:9".into()),
        ("VITE_KORDI_DEV_PROFILE", "community".into()),
    ]);

    // The default agent's and a Factory agent's personal sessions.
    for personal in [
        "session:self-agent:acct_synthetic:personal:cloud-agent:acct_synthetic",
        "session:self-agent:acct_synthetic:personal:cloud_agent_synthetic",
    ] {
        let manager = DesktopChatManager::default();
        // Opening the session (`desktop_chat_session_detail`) makes the in-memory copy.
        ensure_loaded_or_create_explicit_session(&manager, &cwd, personal.to_string())
            .await
            .unwrap();
        // A refresh for another session unloads it before this session's state is built.
        manager.sessions.lock().await.remove(personal);
        // Resuming it, as the state build did, fails: nothing is stored yet.
        let error = resume_desktop_runtime(&cwd, personal)
            .await
            .err()
            .expect("an unsent personal session has no stored row");
        assert!(is_missing_session_error(&error), "{error}");
        // The state build opens it again instead.
        let handle = active_runtime_handle(&manager, &cwd, personal)
            .await
            .unwrap();
        assert_eq!(handle.lock().await.session_id(), personal);

        // The first local turn stores the session; after a restart it resumes.
        handle.lock().await.materialize_session().unwrap();
        let restarted = DesktopChatManager::default();
        assert_eq!(
            ensure_loaded_session(&restarted, &cwd, Some(personal.to_string()))
                .await
                .unwrap(),
            personal
        );
        restarted.sessions.lock().await.remove(personal);
        let resumed = active_runtime_handle(&restarted, &cwd, personal)
            .await
            .unwrap();
        assert_eq!(resumed.lock().await.session_id(), personal);
    }
}

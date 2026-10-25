//! An approved proactive run's turn on the Mac, through the real start and
//! preparation path: its session opens as a proactive run, even when it was
//! loaded as an ordinary chat first, and its prompt carries none of the
//! owner's preloaded memories. An ordinary owner request in the same group
//! keeps them.

use super::group_tools_tests::{group_lease, identity, EnvGuard, GROUP, OWNER};
use super::prepare_desktop_session_for_send;
use crate::chat::session_lifecycle::{
    ensure_loaded_or_create_explicit_session, ensure_loaded_or_create_session,
};
use crate::chat::DesktopChatManager;
use kordi_tools::reflection_tool::GLOBAL_SCOPE_ID;

#[tokio::test(flavor = "multi_thread")]
async fn approved_proactive_runs_get_no_preloaded_memories() {
    let storage = crate::test_support::ScopedKordiStorageRoot::new("proactive-run-memories");
    let root = storage.root().to_path_buf();
    let home = root.join("home");
    let app = root.join("app");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&app).unwrap();
    let _env = EnvGuard::set(&[
        ("HOME", home.into_os_string()),
        ("APP_DATA_DIR", app.into_os_string()),
        ("VITE_KORDI_CLOUD_API_BASE", "http://127.0.0.1:9".into()),
        ("VITE_KORDI_DEV_PROFILE", "community".into()),
    ]);
    crate::cloud_session::store_session_for_test(OWNER).unwrap();
    // The owner's memories as this Mac caches them.
    let storage_settings = kordi_core::settings::Settings::load_global().storage;
    let lessons = kordi_core::config::artifacts_dir(&storage_settings)
        .join("reflection-lessons")
        .join("global")
        .join(format!("{GLOBAL_SCOPE_ID}.md"));
    std::fs::create_dir_all(lessons.parent().unwrap()).unwrap();
    std::fs::write(
        &lessons,
        "# Reflection lessons\n\n- 2026-10-01T10:00:00Z [manual] Reply in metric units.\n",
    )
    .unwrap();

    let manager = DesktopChatManager::default();
    for (request, proactive_run) in [("msg_owner", false), ("proactive_run_synthetic", true)] {
        let session_id = format!("cloud-agent:{OWNER}:{GROUP}:request:{request}");
        let cwd = root.join(request);
        std::fs::create_dir_all(&cwd).unwrap();
        ensure_loaded_or_create_explicit_session(&manager, &cwd, session_id.clone())
            .await
            .unwrap();
        ensure_loaded_or_create_session(&manager, &cwd, session_id.clone(), proactive_run)
            .await
            .unwrap();
        let session = manager.sessions.lock().await.get(&session_id).cloned();
        let session = session.expect("loaded session");
        let mut runtime = session.lock().await;
        assert_eq!(runtime.is_proactive_run(), proactive_run, "{request}");
        let context = vec![identity(OWNER, Some(group_lease()))];
        runtime.sync_shared_context_messages(&context).unwrap();
        prepare_desktop_session_for_send(
            &manager,
            &mut runtime,
            cwd,
            "Look into the failing build.",
            (Some(GROUP), None),
            Some(request),
            &context,
            (None, None),
        )
        .await
        .unwrap();
        let prompt = runtime.next_turn_system_prompt();
        assert_eq!(prompt.contains("## Memories"), !proactive_run, "{request}");
        assert_eq!(
            prompt.contains("Reply in metric units."),
            !proactive_run,
            "{request}"
        );
    }
}

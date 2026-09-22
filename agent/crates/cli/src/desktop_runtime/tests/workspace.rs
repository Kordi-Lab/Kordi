#[allow(
    clippy::await_holding_lock,
    reason = "serialize process-local test configuration"
)]
#[tokio::test]
async fn owner_workspace_is_durable_and_shared_requests_cannot_select_it() -> Result<()> {
    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir()?;
    let _home = EnvVarGuard::set_path("HOME", home.path());
    let _storage = EnvVarGuard::set_path("APP_DATA_DIR", home.path());
    let _key = EnvVarGuard::set_value("OPENAI_API_KEY", "test-only-key");
    Settings {
        default_provider: Some("openai".into()),
        default_model: Some("gpt-4o-mini".into()),
        ..Settings::default()
    }
    .save_global()?;
    let app_dir = home.path().join("app");
    let project = home.path().join("My Project");
    std::fs::create_dir_all(&app_dir)?;
    std::fs::create_dir_all(&project)?;
    std::fs::write(project.join("AGENTS.md"), "Project instruction fixture")?;
    let canonical_project = std::fs::canonicalize(&project)?;
    let id = format!("workspace-{}", uuid::Uuid::new_v4());
    let mut runtime = DesktopRuntimeSession::create_with_id(app_dir.clone(), &id).await?;
    let policy = runtime.turn_execution_policy()?;
    assert_eq!(policy, kordi_tools::ExecutionPolicy::Yolo);
    let workspace =
        runtime.execution_workspace("@\"~/My Project\" inspect the repository", policy)?;
    assert_eq!(workspace, canonical_project);
    let header = super::workspace::environment_prompt("base", &workspace, policy, true);
    assert!(header.contains("Project instruction fixture"));
    assert!(header.contains("YOLO"));
    assert!(header.contains("workingDirectory"));
    drop(runtime);
    let mut resumed = DesktopRuntimeSession::resume(app_dir.clone(), &id).await?;
    assert_eq!(
        resumed.execution_workspace("continue", policy)?,
        canonical_project
    );

    let outsider = home.path().join("Other Project");
    std::fs::create_dir_all(&outsider)?;
    let shared = resumed.execution_workspace(
        "@\"~/Other Project\" inspect",
        kordi_tools::ExecutionPolicy::Shared,
    )?;
    assert_eq!(shared, resumed.setup.tool_ctx.cwd);
    assert_eq!(
        resumed.execution_workspace("continue", policy)?,
        canonical_project
    );
    let shared_header = super::workspace::environment_prompt(
        "base",
        &workspace,
        kordi_tools::ExecutionPolicy::Shared,
        true,
    );
    assert!(!shared_header.contains("My Project"));
    assert!(!shared_header.contains("Project instruction fixture"));
    assert!(
        resumed
            .execution_workspace("continue", kordi_tools::ExecutionPolicy::Safety)
            .is_err()
    );
    std::fs::remove_dir_all(&project)?;
    assert!(resumed.execution_workspace("continue", policy).is_err());
    Ok(())
}

#[test]
fn directory_selection_is_unambiguous_and_does_not_consume_people_or_files() -> Result<()> {
    let root = tempfile::tempdir()?;
    let first = root.path().join("project one");
    let second = root.path().join("project-two");
    std::fs::create_dir_all(&first)?;
    std::fs::create_dir_all(&second)?;
    std::fs::write(root.path().join("file.txt"), "fixture")?;
    assert_eq!(
        super::workspace::referenced_workspace("@Owner @\"./project one\" inspect", root.path()),
        Some(std::fs::canonicalize(&first)?)
    );
    assert!(
        super::workspace::referenced_workspace(
            "compare @\"./project one\" @./project-two",
            root.path()
        )
        .is_none()
    );
    assert!(
        super::workspace::referenced_workspace("@Owner inspect @./file.txt", root.path()).is_none()
    );
    Ok(())
}

#[test]
fn project_reassignment_and_removal_replace_saved_workspace_without_losing_history() -> Result<()> {
    let _lock = env_lock().lock().unwrap();
    let storage = tempfile::tempdir()?;
    let _storage = EnvVarGuard::set_path("KORDI_STORAGE_ROOT", storage.path());
    let chat = tempfile::tempdir()?;
    let project = tempfile::tempdir()?;
    let previous = tempfile::tempdir()?;
    let conn = open_sessions_db()?;
    let id = kordi_session::store::create_session(&conn, chat.path().to_str().unwrap())?;
    workspace::persist_selected_workspace(&conn, &id, previous.path())?;
    let previous_leaf = kordi_session::store::get_session(&conn, &id)?
        .unwrap()
        .leaf_id;

    move_session_to_project(&id, project.path())?;
    let row = kordi_session::store::get_session(&conn, &id)?.unwrap();
    assert_eq!(row.session_scope, "project");
    assert_eq!(row.project_root.as_deref(), project.path().to_str());
    assert_eq!(
        runtime_cwd_for_session(chat.path().into(), &id)?,
        project.path()
    );
    let saved = || -> Result<String> {
        Ok(conn.query_row(
            "SELECT json_extract(payload,'$.data.path') FROM entries WHERE session_id=?1 AND json_extract(payload,'$.custom_type')='desktop_execution_workspace' ORDER BY seq DESC LIMIT 1",
            [&id], |row| row.get(0),
        )?)
    };
    assert_eq!(saved()?, project.path().to_str().unwrap());

    remove_session_from_project(&id, chat.path())?;
    let row = kordi_session::store::get_session(&conn, &id)?.unwrap();
    assert_eq!(row.session_scope, "chat");
    assert_eq!(row.project_root, None);
    assert_eq!(
        runtime_cwd_for_session(project.path().into(), &id)?,
        chat.path()
    );
    assert_eq!(saved()?, chat.path().to_str().unwrap());
    assert!(
        kordi_session::store::get_entry(&conn, &id, previous_leaf.as_deref().unwrap())?.is_some()
    );
    assert!(remove_session_from_project("missing-session", chat.path()).is_err());
    Ok(())
}

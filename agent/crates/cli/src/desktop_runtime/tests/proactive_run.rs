const PROACTIVE_FIXTURES: [&str; 4] = [
    "GLOBAL-INSTRUCTION-FIXTURE",
    "WALKED-AGENTS-FIXTURE",
    "WALKED-CLAUDE-FIXTURE",
    "Reply in metric units.",
];

fn proactive_turn_prompt(runtime: &mut DesktopRuntimeSession, prompt: &str) -> Result<String> {
    let policy = runtime.turn_execution_policy()?;
    let workspace = runtime.execution_workspace(prompt, policy)?;
    let turn = super::turn_execution::build_turn_config(
        &mut runtime.setup,
        tokio_util::sync::CancellationToken::new(),
        policy,
        false,
        workspace,
    )?;
    Ok(turn.system_prompt)
}

fn assert_no_ambient_context(prompt: &str, home: &std::path::Path) {
    for fixture in PROACTIVE_FIXTURES {
        assert!(!prompt.contains(fixture), "{fixture} reached the prompt");
    }
    assert!(!prompt.contains("## Memories"));
    assert!(!prompt.contains("homeDirectory"));
    assert!(!prompt.contains(home.to_str().expect("utf-8 home")));
}

#[allow(clippy::await_holding_lock, reason = "global env lock; #235")]
#[tokio::test]
async fn proactive_run_prompts_load_no_instruction_files_memories_or_home_folder() -> Result<()> {
    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir()?;
    let root = tempfile::tempdir()?;
    let _home = EnvVarGuard::set_path("HOME", home.path());
    let _storage = EnvVarGuard::unset("KORDI_STORAGE_ROOT");
    let _app_data = EnvVarGuard::unset("APP_DATA_DIR");
    let _key = EnvVarGuard::set_value("OPENAI_API_KEY", "test-only-key");
    Settings {
        default_provider: Some("openai".into()),
        default_model: Some("gpt-4o-mini".into()),
        ..Settings::default()
    }
    .save_global()?;
    // The global instruction file, one in the run folder and one above it.
    let global = kordi_core::config::global_agents_md_path();
    assert!(global.starts_with(home.path()), "{}", global.display());
    std::fs::create_dir_all(global.parent().expect("global dir"))?;
    std::fs::write(&global, PROACTIVE_FIXTURES[0])?;
    let run = root.path().join("run");
    std::fs::create_dir_all(root.path().join(".git"))?;
    std::fs::create_dir_all(&run)?;
    std::fs::create_dir_all(home.path().join("repo"))?;
    std::fs::write(root.path().join("AGENTS.md"), PROACTIVE_FIXTURES[1])?;
    std::fs::write(run.join("CLAUDE.md"), PROACTIVE_FIXTURES[2])?;
    let artifacts = kordi_core::config::artifacts_dir(&Settings::load_global().storage);
    let lessons = crate::reflection_runtime::reflection_lesson_artifact_path(
        &artifacts,
        "global",
        kordi_tools::reflection_tool::GLOBAL_SCOPE_ID,
    );
    std::fs::create_dir_all(lessons.parent().expect("lesson dir"))?;
    std::fs::write(
        &lessons,
        "# Reflection lessons\n\n- 2026-10-01T10:00:00Z [manual] Reply in metric units.\n",
    )?;
    let named_folder = "@\"~/repo\" look into this";

    // Every other session keeps its instruction files, memories and home folder.
    let mut chat = DesktopRuntimeSession::create_with_id(run.clone(), "plain-chat").await?;
    assert!(!chat.is_proactive_run());
    for fixture in PROACTIVE_FIXTURES {
        assert!(chat.setup.system_prompt.contains(fixture), "{fixture}");
    }
    let chat_tools = chat.next_turn_tool_names()?;
    let chat_turn = proactive_turn_prompt(&mut chat, named_folder)?;
    assert!(chat_turn.contains("~ against homeDirectory"));
    let named = std::fs::canonicalize(home.path().join("repo"))?;
    assert!(chat_turn.contains(&named.display().to_string()));
    assert!(chat_turn.contains("Instructions applicable to the selected workspace"));

    let run_id = "proactive-run-session";
    let mut proactive = DesktopRuntimeSession::create_proactive_run(run.clone(), run_id).await?;
    assert!(proactive.is_proactive_run());
    assert_no_ambient_context(&proactive.setup.system_prompt, home.path());
    // Preparing a send neither adds the memory block nor a memory note.
    proactive.refresh_memory_prompt_section();
    proactive.record_memory_updates()?;
    assert_no_ambient_context(&proactive.setup.system_prompt, home.path());
    let notes: i64 = proactive.setup.conn.query_row(
        "SELECT COUNT(*) FROM entries WHERE session_id=?1 AND json_extract(payload,'$.custom_type') IN ('memory_update','memory_snapshot')",
        [run_id], |row| row.get(0),
    )?;
    assert_eq!(notes, 0);
    // Tools are unchanged, `reflection` included.
    let tools = proactive.next_turn_tool_names()?;
    assert_eq!(tools, chat_tools);
    assert!(tools.iter().any(|tool| tool == "reflection"));
    assert!(proactive.setup.tool_ctx.reflection.is_some());
    // The turn names no home folder, and a folder named in the prompt does not move it.
    let turn = proactive_turn_prompt(&mut proactive, named_folder)?;
    assert_no_ambient_context(&turn, home.path());
    assert!(!turn.contains("~ against homeDirectory"));
    assert!(turn.contains("workingDirectory is this run's own empty folder"));
    assert!(turn.contains(&std::fs::canonicalize(&run)?.display().to_string()));

    // A later attempt, a reload and a subsession of the run keep the rules.
    proactive.materialize_session()?;
    drop(proactive);
    let mut resumed = DesktopRuntimeSession::resume_proactive_run(run.clone(), run_id).await?;
    assert!(resumed.is_proactive_run());
    assert_no_ambient_context(
        &proactive_turn_prompt(&mut resumed, "continue")?,
        home.path(),
    );
    resumed.reload_resources().await?;
    assert!(resumed.is_proactive_run());
    assert_no_ambient_context(
        &proactive_turn_prompt(&mut resumed, "continue")?,
        home.path(),
    );
    let profile = DesktopRuntimeProfile {
        proactive_run: true,
        ..DesktopRuntimeProfile::default()
    };
    let mut child =
        DesktopRuntimeSession::create_profiled_with_id(run.clone(), "proactive-child", profile)
            .await?;
    assert!(child.is_proactive_run());
    assert_no_ambient_context(&proactive_turn_prompt(&mut child, "continue")?, home.path());
    // Profiles saved before the flag existed are not proactive runs.
    let saved: DesktopRuntimeProfile = serde_json::from_str(
        r#"{"provider":null,"model":null,"thinking":null,"system_prompt":null,"tool_names":null,"skill_names":null,"skill_paths":[]}"#,
    )?;
    assert!(!saved.proactive_run);
    Ok(())
}

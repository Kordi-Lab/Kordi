#[test]
fn session_prompt_context_strips_current_and_legacy_wrappers() {
    assert_eq!(
        strip_session_prompt_context(
            "base\n\n<desktop_session_context>\ncurrent\n</desktop_session_context>"
        ),
        "base"
    );
    assert_eq!(
        strip_session_prompt_context(
            "base\n\n<desktop_bridge_outreach_context>\nlegacy\n</desktop_bridge_outreach_context>"
        ),
        "base"
    );
}

#[test]
fn background_session_lookup_is_idempotent_for_one_parent_request() -> Result<()> {
    let _lock = env_lock().lock().unwrap();
    let home = tempfile::tempdir().expect("home tempdir");
    let cwd = tempfile::tempdir().expect("cwd tempdir");
    let _home = EnvVarGuard::set_path("HOME", home.path());
    let session_id = create_background_session(
        cwd.path(),
        "parent-session",
        Some("request-message"),
        "Review runtime",
    )?;

    let linked = background_session_for_parent_message("parent-session", "request-message")?
        .expect("linked background session");
    assert_eq!(linked.session_id, session_id);
    assert_eq!(linked.title, "Review runtime");
    Ok(())
}

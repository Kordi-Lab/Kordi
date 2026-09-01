use super::*;

#[test]
fn thinking_label_formats_xhigh() {
    assert_eq!(thinking_label("xhigh"), "Extra High");
    assert_eq!(thinking_label("max"), "Max");
}

#[test]
fn local_desktop_agent_label_is_not_inferred_from_project_name() {
    assert_eq!(
        infer_agent_label(
            std::path::Path::new("/tmp/any-project"),
            &Settings::default()
        ),
        "Kordi"
    );
}

#[test]
fn local_desktop_agent_uses_the_saved_owner_name() {
    let settings = Settings {
        agent_name: Some("Scout".to_string()),
        ..Settings::default()
    };
    assert_eq!(
        infer_agent_label(std::path::Path::new("/tmp/any-project"), &settings),
        "Scout"
    );
}

#[test]
fn factory_workspace_uses_specialist_label() {
    assert_eq!(
        infer_agent_label(
            std::path::Path::new("/tmp/.kordi/agent-drafts/draft-id"),
            &Settings {
                agent_name: Some("Scout".to_string()),
                ..Settings::default()
            },
        ),
        "Kordi Factory"
    );
}

#[test]
fn agent_profile_prefers_root_default_over_current_session_model() {
    assert_eq!(
        agent_profile_default_route(
            "openai",
            "gpt-5.4",
            Some(("openai".to_string(), "gpt-5.6-sol".to_string())),
        ),
        ("openai".to_string(), "gpt-5.6-sol".to_string()),
    );
}

#[test]
fn agent_profile_falls_back_to_current_route_without_a_preference() {
    assert_eq!(
        agent_profile_default_route("ollama", "qwen3", None),
        ("ollama".to_string(), "qwen3".to_string()),
    );
}

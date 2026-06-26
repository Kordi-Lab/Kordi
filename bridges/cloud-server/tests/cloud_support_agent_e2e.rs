#[test]
fn support_agent_migration_is_registered_and_adds_system_managed_flag() {
    let pool_source = std::fs::read_to_string("src/pg/pool.rs").expect("read pool source");
    assert!(pool_source.contains("0027_system_support_agent.sql"));

    let migration = std::fs::read_to_string("migrations/0027_system_support_agent.sql")
        .expect("read support agent migration");
    assert!(migration.contains("ALTER TABLE cloud_agent_definitions"));
    assert!(migration.contains("is_system_managed"));
}

#[test]
fn support_agent_definition_is_system_managed_and_locked_in_source() {
    let models = std::fs::read_to_string("src/cloud_agents/models.rs").expect("read models");
    let store = std::fs::read_to_string("src/cloud_agents/store.rs").expect("read store");
    let routes = std::fs::read_to_string("src/cloud_agents/routes.rs").expect("read routes");

    assert!(models.contains("system_managed"));
    assert!(store.contains("upsert_system_support_agent_definition"));
    assert!(store.contains("CloudAgentStoreError::SystemManaged"));
    assert!(routes.contains("system_managed_cloud_agent"));
}

#[test]
fn support_agent_contact_is_appended_and_messages_are_allowed_without_contact_row() {
    let auth_routes = std::fs::read_to_string("src/auth/routes.rs").expect("read auth routes");
    let support = std::fs::read_to_string("src/support_agent.rs").expect("read support module");

    assert!(auth_routes.contains("support_agent_contact_summary"));
    assert!(auth_routes.contains("message_targets_support_agent"));
    assert!(auth_routes.contains("claim_support_agent_run_for_message"));
    assert!(support.contains("SupportContactSummaryFields"));
}

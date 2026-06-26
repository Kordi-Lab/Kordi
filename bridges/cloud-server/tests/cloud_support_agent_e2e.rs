#[test]
fn support_agent_migration_is_registered_and_adds_system_managed_flag() {
    let pool_source = std::fs::read_to_string("src/pg/pool.rs").expect("read pool source");
    assert!(pool_source.contains("0027_system_support_agent.sql"));

    let migration = std::fs::read_to_string("migrations/0027_system_support_agent.sql")
        .expect("read support agent migration");
    assert!(migration.contains("ALTER TABLE cloud_agent_definitions"));
    assert!(migration.contains("is_system_managed"));
}

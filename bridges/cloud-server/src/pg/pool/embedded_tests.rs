use super::EMBEDDED_MIGRATIONS;

/// Recorded before the entries from version 100 on were compacted. The runner
/// refuses a recorded version whose description differs, so these must never
/// change.
const RECORDED_FROM_100: &[(i64, &str)] = &[
    (100, "provider auth profile labels"),
    (101, "provider auth model hint"),
    (102, "provider auth login sessions"),
    (103, "provider auth login session method"),
    (104, "provider auth payload version"),
    (105, "provider auth snapshot readiness"),
    (107, "account email verification"),
    (108, "session-bound realtime tickets"),
    (109, "runner run token hash"),
    (
        112,
        "agent trust: AI access, opt-outs, pending actions, run disclosure",
    ),
];

#[test]
fn compact_entries_keep_their_recorded_versions_and_descriptions() {
    for pair in EMBEDDED_MIGRATIONS.windows(2) {
        assert!(pair[0].version < pair[1].version);
    }
    let from_100 = EMBEDDED_MIGRATIONS
        .iter()
        .filter(|migration| migration.version >= 100)
        .map(|migration| (migration.version, migration.description))
        .collect::<Vec<_>>();
    assert_eq!(from_100, RECORDED_FROM_100);
}

#[test]
fn compact_entries_embed_their_own_files() {
    let find = |version: i64| {
        EMBEDDED_MIGRATIONS
            .iter()
            .find(|migration| migration.version == version)
            .unwrap()
    };
    assert!(find(109).sql.contains("runner_run_token_hash"));
    assert!(find(112).sql.contains("cloud_chat_ai_policies"));
    assert!(find(100).sql.contains("label"));
}

use super::EMBEDDED_MIGRATIONS;

/// The versions and descriptions this build records from version 100 on. The
/// runner refuses a recorded version whose description differs, so a listed
/// entry must never change; a new migration adds its own entry.
const RECORDED_FROM_100: &[(i64, &str)] = &[
    (100, "provider auth profile labels"),
    (101, "provider auth model hint"),
    (102, "provider auth login sessions"),
    (103, "provider auth login session method"),
    (104, "provider auth payload version"),
    (105, "provider auth snapshot readiness"),
    (106, "private OMP runtime replay state"),
    (107, "account-scoped desktop projects"),
    (108, "session pin stacks"),
    (109, "session-bound realtime tickets"),
    (110, "contact consent and blocks"),
    (111, "abuse reports"),
    (
        112,
        "agent trust: AI access, opt-outs, pending actions, run disclosure",
    ),
    (113, "runner run token hash"),
    (114, "desktop device proofs"),
    (116, "content removal jobs and deletion indexes"),
    (117, "keep removed files-panel entries archived"),
    (118, "OMP state replay flag"),
    (119, "device key rotation"),
    (120, "account email verification"),
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
    assert!(find(100).sql.contains("label"));
    assert!(find(110).sql.contains("cloud_account_blocks"));
    assert!(find(112).sql.contains("cloud_chat_ai_policies"));
    assert!(find(113).sql.contains("runner_run_token_hash"));
}

//! Response shapes and tool-group policy.

use super::*;

// ---------------------------------------------------------------------------
// 1. Response shape

#[test]
fn no_connector_response_type_has_a_secret_shaped_key() {
    assert!(is_secret_key("accessToken") && is_secret_key("refresh_ciphertext"));
    let summary = ConnectorSummary::from_record(
        record(ConnectorStatus::Revoked, true),
        vec!["cloud-agent:acct_sample".into()],
    );
    let audit = ConnectorAuditEntry {
        audit_id: "cnaud_1".into(),
        connector_id: "conn_sample".into(),
        run_id: Some("run_1".into()),
        agent_id: Some("agent_1".into()),
        tool: "calendar.list_events".into(),
        tool_group: ConnectorToolGroup::Read,
        outcome: "completed".into(),
        summary: "Completed.".into(),
        created_at: Utc::now().to_rfc3339(),
    };
    let samples: Vec<(&str, Value)> = vec![
        ("ConnectorSummary", serde_json::to_value(&summary).unwrap()),
        (
            "ConnectorListResponse",
            serde_json::to_value(ConnectorListResponse {
                connectors: vec![summary.clone()],
                agents: vec![ConnectorAgent {
                    agent_id: "cloud-agent:acct_sample".into(),
                    name: "Kordi".into(),
                    is_default: true,
                }],
            })
            .unwrap(),
        ),
        (
            "ConnectorResponse",
            serde_json::to_value(ConnectorResponse {
                connector: summary.clone(),
            })
            .unwrap(),
        ),
        (
            "OAuthStartResponse",
            serde_json::to_value(OAuthStartResponse {
                auth_url: "https://example.test/authorize".into(),
            })
            .unwrap(),
        ),
        (
            "OAuthCompletedFragment",
            serde_json::to_value(OAuthCompletedFragment {
                connector_id: "conn_sample".into(),
                provider: "github".into(),
                grant: ConnectorToolGroup::Act,
                status: ConnectorStatus::Connected,
            })
            .unwrap(),
        ),
        ("ConnectorAuditEntry", serde_json::to_value(&audit).unwrap()),
        (
            "ConnectorAuditResponse",
            serde_json::to_value(ConnectorAuditResponse {
                entries: vec![audit],
                next_before: Some(Utc::now().to_rfc3339()),
            })
            .unwrap(),
        ),
        (
            "DisconnectResponse",
            serde_json::to_value(DisconnectResponse { deleted_events: 3 }).unwrap(),
        ),
        (
            "BrokerCallResponse(ok)",
            serde_json::to_value(BrokerCallResponse::success(json!({ "items": [] }))).unwrap(),
        ),
        (
            "BrokerCallResponse(error)",
            serde_json::to_value(BrokerCallResponse::failure("denied", "Denied.")).unwrap(),
        ),
    ];
    for (label, value) in samples {
        assert_no_secret_keys(label, value);
    }
}

/// `ConnectorSummary` is built only from `ConnectorRecord`, which is loaded
/// with `CONNECTOR_COLUMNS`. `ConnectorSummary::from_record` destructures the
/// record exhaustively, so adding a field fails to compile until reviewed;
/// this test pins the column list to `cloud_connectors` columns.
#[test]
fn connector_summary_is_built_from_cloud_connectors_columns_only() {
    let columns = CONNECTOR_COLUMNS
        .split(',')
        .map(str::trim)
        .collect::<Vec<_>>();
    assert_eq!(
        columns,
        [
            "connector_id",
            "account_id",
            "provider",
            "status",
            "read_scopes",
            "act_scopes",
            "act_enabled",
            "created_at",
            "updated_at",
            "revoked_at",
            "settings",
            "provider_account_id",
            "last_event_at"
        ]
    );
    assert!(columns.iter().all(|column| !is_secret_key(column)));
    let migration = include_str!("../../../migrations/0114_cloud_connectors.sql");
    let table = migration
        .split("CREATE TABLE cloud_connectors (")
        .nth(1)
        .and_then(|rest| rest.split(");").next())
        .unwrap();
    let added = include_str!("../../../migrations/0115_connector_provider_state.sql");
    for column in columns {
        assert!(
            table.contains(&format!("    {column} "))
                || added.contains(&format!("ADD COLUMN {column} ")),
            "{column} is not a cloud_connectors column"
        );
    }
}

#[test]
fn connector_secret_debug_redacts_tokens() {
    let secret = ConnectorSecret {
        access_token: "plain-access".into(),
        refresh_token: Some("plain-refresh".into()),
        expires_at: None,
    };
    let rendered = format!("{secret:?}");
    assert!(!rendered.contains("plain-access") && !rendered.contains("plain-refresh"));
}

// ---------------------------------------------------------------------------
// 2. allowed_tool_groups

#[test]
fn allowed_tool_groups_covers_every_combination() {
    use ConnectorStatus::*;
    use ConnectorToolGroup::*;
    use RunTrigger::*;
    let cases = [
        (Connected, false, PersonStarted, vec![Read]),
        (Connected, false, Background, vec![Read]),
        (Connected, true, PersonStarted, vec![Read, Act]),
        (Connected, true, Background, vec![Read]),
        (NeedsReauth, false, PersonStarted, vec![]),
        (NeedsReauth, false, Background, vec![]),
        (NeedsReauth, true, PersonStarted, vec![]),
        (NeedsReauth, true, Background, vec![]),
        (Revoked, false, PersonStarted, vec![]),
        (Revoked, false, Background, vec![]),
        (Revoked, true, PersonStarted, vec![]),
        (Revoked, true, Background, vec![]),
    ];
    for (status, act_enabled, trigger, expected) in cases {
        assert_eq!(
            allowed_tool_groups(&record(status, act_enabled), trigger),
            expected,
            "{status:?} act_enabled={act_enabled} {trigger:?}"
        );
    }
}

#[test]
fn background_runs_never_receive_act_tool_descriptors() {
    let stub = StubConnectorProvider::default();
    let connector = record(ConnectorStatus::Connected, true);
    let names = |trigger| {
        broker::tools_for_trigger(&connector, &stub, trigger)
            .into_iter()
            .map(|tool| tool.name)
            .collect::<Vec<_>>()
    };
    assert_eq!(names(RunTrigger::Background), [STUB_READ_TOOL]);
    assert_eq!(
        names(RunTrigger::PersonStarted),
        [STUB_READ_TOOL, STUB_ACT_TOOL]
    );
}

//! Service connectors against a local HTTP stub (no database).

use super::http_stub::HttpStub;
use super::*;
use crate::connectors::providers::{github, slack, ConnectorProvider, ProviderError};

pub(super) const ACCESS: &str = "live-access-token-123";

pub(super) fn secret() -> ConnectorSecret {
    ConnectorSecret {
        access_token: ACCESS.into(),
        refresh_token: Some("live-refresh-token-456".into()),
        expires_at: None,
    }
}

pub(super) fn http() -> reqwest::Client {
    reqwest::Client::new()
}

/// Every tool result must be token-free: no secret-shaped key and no
/// credential value anywhere in it.
pub(super) fn assert_clean(label: &str, value: &Value) {
    assert_no_secret_keys(label, value.clone());
    let text = value.to_string();
    assert!(
        !text.contains(ACCESS) && !text.contains("live-refresh"),
        "{label} leaks a credential"
    );
}

pub(super) async fn run(
    provider: &dyn ConnectorProvider,
    tool: &str,
    args: Value,
    settings: &Value,
) -> Result<Value, ProviderError> {
    let result = provider.execute(tool, &args, &secret(), settings).await;
    if let Ok(value) = &result {
        assert_clean(tool, value);
    }
    result
}

#[test]
fn tool_tables_are_named_grouped_and_described() {
    let registry = ProviderRegistry::production();
    let expected = [
        (
            "google_calendar",
            "calendar_list_events",
            ConnectorToolGroup::Read,
        ),
        (
            "google_calendar",
            "calendar_respond",
            ConnectorToolGroup::Act,
        ),
        (
            "google_calendar",
            "calendar_create_event",
            ConnectorToolGroup::Act,
        ),
        ("gmail", "gmail_search", ConnectorToolGroup::Read),
        ("gmail", "gmail_read_message", ConnectorToolGroup::Read),
        ("gmail", "gmail_send", ConnectorToolGroup::Act),
        ("github", "github_notifications", ConnectorToolGroup::Read),
        ("github", "github_pull_request", ConnectorToolGroup::Read),
        ("github", "github_comment", ConnectorToolGroup::Act),
        ("slack", "slack_read_channel", ConnectorToolGroup::Read),
        ("slack", "slack_post", ConnectorToolGroup::Act),
    ];
    let mut seen = 0;
    for (provider_id, tool, group) in expected {
        let provider = registry.get(provider_id).unwrap();
        assert_eq!(provider.tool_group(tool), Some(group), "{tool}");
        seen += 1;
    }
    let mut keys = Vec::new();
    for provider_id in ["google_calendar", "gmail", "github", "slack"] {
        for tool in registry.get(provider_id).unwrap().tools() {
            assert!(
                tool.name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'),
                "{} is not a valid tool name",
                tool.name
            );
            assert!(!tool.description.is_empty());
            let schema = crate::connectors::tool_schemas::input_schema(tool.name);
            assert_eq!(schema["type"], "object", "{}", tool.name);
            assert!(
                schema.get("properties").is_some(),
                "{} has a schema",
                tool.name
            );
            collect_keys(&schema, &mut keys);
            seen -= 1;
        }
    }
    assert_eq!(seen, 0, "every tool is listed above");
    assert!(keys.iter().all(|key| !is_secret_key(key)), "{keys:?}");
}

#[test]
fn granted_scopes_map_to_catalog_ids() {
    let granted = |values: &[&str]| values.iter().map(|v| v.to_string()).collect::<Vec<_>>();
    assert_eq!(
        providers::GITHUB.catalog_scope_ids(&granted(&["read:user", "notifications"])),
        ["github.notifications.read", "github.pulls.read"]
    );
    assert_eq!(
        providers::SLACK.catalog_scope_ids(&granted(&[
            "channels:history",
            "groups:history",
            "chat:write"
        ])),
        ["slack.channels.read", "slack.messages.write"]
    );
    assert_eq!(
        providers::GMAIL.catalog_scope_ids(&granted(&[
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/gmail.send",
        ])),
        [
            "gmail.messages.read",
            "gmail.labels.read",
            "gmail.messages.send"
        ]
    );
    let mut connector = record(ConnectorStatus::Connected, true);
    connector.read_scopes = vec!["https://www.googleapis.com/auth/calendar.readonly".into()];
    connector.act_scopes = vec!["https://www.googleapis.com/auth/calendar.events".into()];
    let summary = serde_json::to_value(ConnectorSummary::from_record(connector, vec![])).unwrap();
    assert_eq!(
        summary["grantedScopeIds"],
        json!([
            "google_calendar.events.read",
            "google_calendar.freebusy.read",
            "google_calendar.invitations.reply",
            "google_calendar.events.write"
        ])
    );
    assert!(summary["lastEventAt"].is_string());
    assert!(summary.get("providerAccountId").is_none());
}

#[tokio::test]
async fn github_tools_read_and_comment_with_caps() {
    let stub = HttpStub::start().await;
    let provider = github::provider(http(), Some(stub.base.clone()));
    let notifications = (0..60)
        .map(|i| {
            json!({ "id": format!("{i}"), "reason": "review_requested", "unread": true,
                    "updated_at": "2026-10-07T10:00:00Z",
                    "subject": { "title": "Fix login", "type": "PullRequest", "url": "x" },
                    "repository": { "full_name": "kordi/app" }, "url": "https://api/x?access_token=leak" })
        })
        .collect::<Vec<_>>();
    stub.respond("GET", "/notifications", json!(notifications));
    let listed = run(&provider, "github_notifications", json!({}), &json!({}))
        .await
        .unwrap();
    assert_eq!(listed["notifications"].as_array().unwrap().len(), 50);
    assert!(!listed.to_string().contains("leak"));
    let call = &stub.requests_to("GET", "/notifications")[0];
    assert_eq!(call.authorization, format!("Bearer {ACCESS}"));

    stub.respond(
        "GET",
        "/repos/kordi/app/pulls/7",
        json!({ "title": "Fix login", "state": "open", "merged": false, "draft": false,
                "user": { "login": "alex" }, "head": { "sha": "abc123" },
                "html_url": "https://github.com/kordi/app/pull/7", "body": "x".repeat(10_000) }),
    );
    stub.respond(
        "GET",
        "/repos/kordi/app/pulls/7/reviews",
        json!([{ "user": { "login": "sam" }, "state": "APPROVED", "submitted_at": "2026-10-07T09:00:00Z" }]),
    );
    stub.respond(
        "GET",
        "/repos/kordi/app/commits/abc123/check-runs",
        json!({ "total_count": 3, "check_runs": [
            { "name": "build", "status": "completed", "conclusion": "success" },
            { "name": "lint", "status": "completed", "conclusion": "failure" },
            { "name": "e2e", "status": "in_progress", "conclusion": null }
        ]}),
    );
    let pull = run(
        &provider,
        "github_pull_request",
        json!({ "owner": "kordi", "repo": "app", "number": 7 }),
        &json!({}),
    )
    .await
    .unwrap();
    assert_eq!(pull["state"], "open");
    assert_eq!(pull["reviews"][0]["state"], "APPROVED");
    assert_eq!(pull["checks"]["success"], 1);
    assert_eq!(pull["checks"]["failing"], json!(["lint"]));
    assert_eq!(pull["checks"]["pending"], 1);
    assert_eq!(pull["body"].as_str().unwrap().chars().count(), 4003);

    stub.respond(
        "POST",
        "/repos/kordi/app/issues/7/comments",
        json!({ "id": 99, "html_url": "https://github.com/kordi/app/pull/7#c99" }),
    );
    let comment = run(
        &provider,
        "github_comment",
        json!({ "owner": "kordi", "repo": "app", "number": 7, "body": "Looks good." }),
        &json!({}),
    )
    .await
    .unwrap();
    assert_eq!(comment["id"], 99);
    let posted = &stub.requests_to("POST", "/repos/kordi/app/issues/7/comments")[0];
    assert_eq!(
        serde_json::from_str::<Value>(&posted.body).unwrap(),
        json!({ "body": "Looks good." })
    );

    let bad = run(
        &provider,
        "github_comment",
        json!({ "owner": "../etc", "repo": "app", "number": 7, "body": "x" }),
        &json!({}),
    )
    .await;
    assert!(matches!(bad, Err(ProviderError::InvalidInput(_))));
    stub.reject_token(ACCESS);
    let expired = run(&provider, "github_notifications", json!({}), &json!({})).await;
    assert!(matches!(expired, Err(ProviderError::Unauthorized)));
}

#[test]
fn slack_settings_accept_only_channel_ids() {
    let registry = ProviderRegistry::production();
    let slack = registry.get("slack").unwrap();
    assert_eq!(
        slack.validate_settings(&json!({ "channels": ["C123ABC", "C123ABC", " G999 "] })),
        Ok(json!({ "channels": ["C123ABC", "G999"] }))
    );
    assert_eq!(
        slack.validate_settings(&json!({})),
        Ok(json!({ "channels": [] }))
    );
    for bad in [
        json!({ "channels": ["general"] }),
        json!({ "channels": "C123" }),
        json!({ "channels": ["C1"], "extra": true }),
        json!(["C123"]),
        json!({ "channels": (0..51).map(|i| format!("C{i:04}")).collect::<Vec<_>>() }),
    ] {
        assert!(slack.validate_settings(&bad).is_err(), "{bad}");
    }
    let github = registry.get("github").unwrap();
    assert!(github.validate_settings(&json!({})).is_ok());
    assert!(github
        .validate_settings(&json!({ "channels": [] }))
        .is_err());
}

#[tokio::test]
async fn slack_reads_and_posts_only_in_chosen_channels() {
    let stub = HttpStub::start().await;
    let provider = slack::provider(http(), Some(stub.base.clone()));
    let settings = json!({ "channels": ["C0CHOSEN"] });
    let refused = run(
        &provider,
        "slack_read_channel",
        json!({ "channel": "C0OTHER" }),
        &settings,
    )
    .await;
    assert!(matches!(refused, Err(ProviderError::InvalidInput(_))));
    let refused_post = run(
        &provider,
        "slack_post",
        json!({ "channel": "C0OTHER", "text": "hi" }),
        &settings,
    )
    .await;
    assert!(matches!(refused_post, Err(ProviderError::InvalidInput(_))));
    assert!(stub.requests().is_empty(), "refusals never reach Slack");

    let messages = (0..80)
        .map(|i| json!({ "ts": format!("1759800000.{i:06}"), "user": "U1", "text": "t".repeat(5000) }))
        .collect::<Vec<_>>();
    stub.respond(
        "GET",
        "/conversations.history",
        json!({ "ok": true, "messages": messages, "response_metadata": { "next_cursor": "c" } }),
    );
    let read = run(
        &provider,
        "slack_read_channel",
        json!({ "channel": "C0CHOSEN", "limit": 500 }),
        &settings,
    )
    .await
    .unwrap();
    assert_eq!(read["messages"].as_array().unwrap().len(), 50);
    assert_eq!(
        read["messages"][0]["text"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        2003
    );
    assert!(stub.requests_to("GET", "/conversations.history")[0]
        .query
        .contains("limit=50"));

    stub.respond(
        "POST",
        "/chat.postMessage",
        json!({ "ok": true, "channel": "C0CHOSEN", "ts": "1759800001.000100" }),
    );
    let posted = run(
        &provider,
        "slack_post",
        json!({ "channel": "C0CHOSEN", "text": "On it." }),
        &settings,
    )
    .await
    .unwrap();
    assert_eq!(posted["ts"], "1759800001.000100");

    stub.respond(
        "GET",
        "/conversations.history",
        json!({ "ok": false, "error": "token_revoked" }),
    );
    let revoked = run(
        &provider,
        "slack_read_channel",
        json!({ "channel": "C0CHOSEN" }),
        &settings,
    )
    .await;
    assert!(matches!(revoked, Err(ProviderError::Unauthorized)));
}

#[tokio::test]
async fn polling_hooks_report_compact_events() {
    let stub = HttpStub::start().await;
    let provider = github::provider(http(), Some(stub.base.clone()));
    stub.respond(
        "GET",
        "/notifications",
        json!([{ "id": "n1", "reason": "mention", "unread": true, "updated_at": "2026-10-07T10:00:00Z",
                 "subject": { "title": "Ping", "type": "Issue" }, "repository": { "full_name": "kordi/app" } }]),
    );
    let since = Utc::now() - ChronoDuration::hours(1);
    let events = provider.poll(&secret(), since, &json!({})).await.unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0].external_id,
        "notification:n1:2026-10-07T10:00:00Z"
    );
    assert_clean("github poll", &events[0].payload);
    assert!(stub.requests_to("GET", "/notifications")[0]
        .query
        .contains("since="));

    let hooks = crate::connectors::ConnectorHooks {
        github_webhook_secret: Some("whsec".into()),
        ..Default::default()
    };
    assert!(provider.live_subscription(&hooks));
    assert!(!provider.live_subscription(&Default::default()));
}

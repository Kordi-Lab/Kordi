use super::*;
use kordi_core::error::KordiResult;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::{Tool, ToolContext, ToolRiskLevel};

fn unreachable_reader<R: Send + 'static>() -> MacLocalFn<R> {
    Arc::new(|_| Box::pin(async { panic!("reader must not run") }))
}

fn runtime(notification_center_enabled: bool) -> MacLocalRuntime {
    MacLocalRuntime {
        read_events: Arc::new(|request: MacCalendarEventsRequest| {
            Box::pin(async move {
                let events = (0..250)
                    .map(|index| json!({"title": format!("Event {index}"), "calendar": request.from}))
                    .collect::<Vec<_>>();
                Ok(json!({ "events": events }))
            })
        }),
        read_reminders: Arc::new(|request: MacRemindersRequest| {
            Box::pin(async move {
                Ok(
                    json!({"reminders":[{"title":"Pay rent","completed":request.include_completed}]}),
                )
            })
        }),
        search_contacts: Arc::new(|request: MacContactsSearchRequest| {
            Box::pin(async move {
                let contacts = (0..60)
                    .map(|index| json!({"name": format!("{} {index}", request.query)}))
                    .collect::<Vec<_>>();
                Ok(json!({ "contacts": contacts }))
            })
        }),
        recent_notifications: Arc::new(|_| {
            Box::pin(async {
                Ok(
                    json!({"notifications":[{"app":"Mail","title":"Hi","body":"x".repeat(900),"time":"2026-10-06T00:00:00Z"}]}),
                )
            })
        }),
        calendar_enabled: true,
        contacts_enabled: true,
        notification_center_enabled,
    }
}

fn context(mac_local: Option<MacLocalRuntime>) -> ToolContext {
    ToolContext {
        cwd: std::env::temp_dir(),
        artifacts_dir: std::env::temp_dir(),
        model: None,
        execution_policy: crate::ExecutionPolicy::Safety,
        invocation_id: None,
        on_output: None,
        web_search: None,
        reach_out: None,
        reflection: None,
        session_observation: None,
        task_operator: None,
        schedule_task: None,
        mac_local,
        execution_mode: crate::ToolExecutionMode::Interactive,
        request_approval: None,
    }
}

async fn run(tool: &dyn Tool, args: Value, ctx: &ToolContext) -> KordiResult<Value> {
    tool.execute(args, ctx, CancellationToken::new())
        .await
        .map(|result| result.details.unwrap())
}

#[tokio::test]
async fn mac_local_tools_fail_closed_without_a_runtime() {
    let ctx = context(None);
    let cases: [(&dyn Tool, Value); 4] = [
        (
            &MacCalendarReadEventsTool,
            json!({"from":"2026-10-01T00:00:00Z","to":"2026-10-02T00:00:00Z"}),
        ),
        (&MacCalendarReadRemindersTool, json!({})),
        (&MacContactsSearchTool, json!({"query":"Ada"})),
        (&MacNotificationCenterRecentTool, json!({})),
    ];
    for (tool, args) in cases {
        let error = run(tool, args, &ctx).await.unwrap_err();
        assert!(
            error.to_string().contains("not an empty result"),
            "{}",
            tool.name()
        );
        assert!(!tool.allows_shared_requests());
    }
}

#[tokio::test]
async fn mac_local_tools_fail_closed_when_the_source_is_off() {
    let mut runtime = runtime(false);
    runtime.calendar_enabled = false;
    runtime.contacts_enabled = false;
    runtime.read_events = unreachable_reader();
    runtime.search_contacts = unreachable_reader();
    runtime.recent_notifications = unreachable_reader();
    let ctx = context(Some(runtime));
    assert!(
        run(
            &MacCalendarReadEventsTool,
            json!({"from":"2026-10-01T00:00:00Z","to":"2026-10-02T00:00:00Z"}),
            &ctx
        )
        .await
        .is_err()
    );
    assert!(
        run(&MacContactsSearchTool, json!({"query":"Ada"}), &ctx)
            .await
            .is_err()
    );
    assert!(
        run(&MacNotificationCenterRecentTool, json!({}), &ctx)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn mac_local_tools_are_blocked_for_shared_requests() {
    let mut ctx = context(Some(runtime(true)));
    ctx.execution_policy = crate::ExecutionPolicy::Shared;
    assert!(
        run(&MacCalendarReadRemindersTool, json!({}), &ctx)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn mac_local_calendar_window_and_event_caps() {
    let ctx = context(Some(runtime(false)));
    let value = run(
        &MacCalendarReadEventsTool,
        json!({"from":"2026-10-01T00:00:00Z","to":"2026-10-31T00:00:00Z"}),
        &ctx,
    )
    .await
    .unwrap();
    assert_eq!(value["events"].as_array().unwrap().len(), MAX_EVENTS);
    assert_eq!(value["truncated"], json!(true));
    for args in [
        json!({"from":"2026-10-01T00:00:00Z","to":"2026-11-02T00:00:01Z"}),
        json!({"from":"2026-10-02T00:00:00Z","to":"2026-10-01T00:00:00Z"}),
        json!({"from":"tomorrow","to":"2026-10-01T00:00:00Z"}),
        json!({"from":"2026-10-01T00:00:00Z"}),
        json!({"from":"2026-10-01T00:00:00Z","to":"2026-10-02T00:00:00Z","accountId":"x"}),
    ] {
        assert!(run(&MacCalendarReadEventsTool, args, &ctx).await.is_err());
    }
}

#[tokio::test]
async fn mac_local_contacts_require_a_query_and_respect_limit() {
    let ctx = context(Some(runtime(false)));
    let value = run(
        &MacContactsSearchTool,
        json!({"query":" Ada ","limit":5}),
        &ctx,
    )
    .await
    .unwrap();
    let contacts = value["contacts"].as_array().unwrap();
    assert_eq!(contacts.len(), 5);
    assert_eq!(contacts[0]["name"], json!("Ada 0"));
    let value = run(&MacContactsSearchTool, json!({"query":"Ada"}), &ctx)
        .await
        .unwrap();
    assert_eq!(
        value["contacts"].as_array().unwrap().len(),
        DEFAULT_CONTACTS
    );
    for args in [
        json!({}),
        json!({"query":""}),
        json!({"query":" a "}),
        json!({"query":"Ada","limit":51}),
        json!({"query":"Ada","limit":0}),
    ] {
        assert!(run(&MacContactsSearchTool, args, &ctx).await.is_err());
    }
}

#[tokio::test]
async fn mac_local_notification_caps_hours_limit_and_body() {
    let ctx = context(Some(runtime(true)));
    let value = run(
        &MacNotificationCenterRecentTool,
        json!({"hours":2,"limit":10}),
        &ctx,
    )
    .await
    .unwrap();
    let body = value["notifications"][0]["body"].as_str().unwrap();
    assert_eq!(body.chars().count(), MAX_NOTIFICATION_BODY_CHARS + 3);
    for args in [
        json!({"hours":25}),
        json!({"hours":0}),
        json!({"limit":101}),
    ] {
        assert!(
            run(&MacNotificationCenterRecentTool, args, &ctx)
                .await
                .is_err()
        );
    }
}

#[test]
fn mac_local_tool_set_follows_runtime_flags() {
    assert!(mac_local_tools(None).is_empty());
    let names = |runtime: &MacLocalRuntime| {
        mac_local_tools(Some(runtime))
            .iter()
            .map(|tool| tool.name().to_string())
            .collect::<Vec<_>>()
    };
    assert_eq!(names(&runtime(true)), MAC_LOCAL_TOOL_NAMES);
    assert_eq!(names(&runtime(false)), &MAC_LOCAL_TOOL_NAMES[..3]);
    for tool in mac_local_tools(Some(&runtime(true))) {
        assert_eq!(tool.metadata().risk, ToolRiskLevel::ReadOnly);
        assert!(tool.description().contains("on this Mac"));
        assert!(tool.description().contains("permission"));
    }
    let nc = MacNotificationCenterRecentTool.description();
    assert!(nc.contains("Experimental") && nc.contains("read-only") && nc.contains("best effort"));
    assert!(nc.contains("Never save notification contents to lessons"));
}

//! After a turn reads the owner's calendar for sharing, only conversation
//! reads and the calendar stay available, for built-in, MCP, and extension
//! tools alike.
use super::{tests::test_context, *};
use async_trait::async_trait;
use std::sync::atomic::{AtomicBool, Ordering};

struct ExtensionTool;
#[async_trait]
impl Tool for ExtensionTool {
    fn name(&self) -> &str {
        "mcp__notes__append"
    }
    fn description(&self) -> &str {
        "An extension tool that writes outside Kordi"
    }
    fn parameters_schema(&self) -> Value {
        json!({"type":"object"})
    }
    async fn execute(
        &self,
        _: Value,
        _: &ToolContext,
        _: CancellationToken,
    ) -> KordiResult<ToolResult> {
        panic!("Refused before execution")
    }
}

fn context_with_calendar(disclosed: Arc<AtomicBool>) -> ToolContext {
    let mut ctx = test_context();
    ctx.session_observation = Some(crate::SessionObservationRuntime {
        calendar: Some(crate::calendar::CalendarRuntime {
            read: Arc::new(|_| Box::pin(async { Ok(json!({})) })),
            disclosed,
        }),
        search_sessions: Arc::new(|_| Box::pin(async { unreachable!() })),
        read_session: Arc::new(|_| Box::pin(async { unreachable!() })),
    });
    ctx
}

#[tokio::test]
async fn shared_calendar_reads_close_every_other_tool_for_the_turn() {
    let disclosed = Arc::new(AtomicBool::new(false));
    let ctx = context_with_calendar(disclosed.clone());
    let tools = crate::builtin_tools();
    for tool in &tools {
        assert!(
            ensure_tool_allowed(tool.as_ref(), &ctx).is_ok(),
            "{} before disclosure",
            tool.name()
        );
    }
    assert!(ensure_tool_allowed(&ExtensionTool, &ctx).is_ok());

    disclosed.store(true, Ordering::SeqCst);
    for tool in &tools {
        let allowed = matches!(
            tool.name(),
            "read_session" | "search_sessions" | "read_calendar"
        );
        let result = ensure_tool_allowed(tool.as_ref(), &ctx);
        assert_eq!(result.is_ok(), allowed, "{}", tool.name());
        if !allowed {
            assert!(
                result
                    .unwrap_err()
                    .to_string()
                    .contains(crate::calendar::CALENDAR_EGRESS_CLOSED)
            );
        }
    }
    let refused = execute_tool_call(
        &ExtensionTool,
        json!({}),
        &ctx,
        CancellationToken::new(),
        &FileQueue::new(),
    )
    .await
    .unwrap_err();
    assert!(
        refused
            .to_string()
            .contains(crate::calendar::CALENDAR_EGRESS_CLOSED)
    );
    // A turn without a calendar runtime is unaffected.
    assert!(ensure_tool_allowed(&ExtensionTool, &test_context()).is_ok());
}

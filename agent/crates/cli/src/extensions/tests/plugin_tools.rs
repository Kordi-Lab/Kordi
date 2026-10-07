use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

fn context(cwd: &Path, id: &str, chunks: Arc<AtomicUsize>) -> ToolContext {
    ToolContext {
        cwd: cwd.to_path_buf(),
        artifacts_dir: cwd.to_path_buf(),
        invocation_id: Some(id.to_string()),
        model: None,
        execution_policy: kordi_tools::ExecutionPolicy::Yolo,
        on_output: Some(Box::new(move |chunk| {
            if chunk == "working" {
                chunks.fetch_add(1, Ordering::SeqCst);
            }
        })),
        web_search: None,
        reach_out: None,
        reflection: None,
        session_observation: None,
        task_operator: None,
        schedule_task: None,
        execution_mode: kordi_tools::ToolExecutionMode::Interactive,
        connector_tools: None,
        request_approval: None,
    }
}

#[tokio::test]
async fn plugin_tool_uses_model_call_id_and_recovers_after_cancellation() {
    if !node_available() {
        return;
    }
    let dir = tempdir().unwrap();
    let path = dir.path().join("tool.js");
    fs::write(
        &path,
        r#"module.exports = kordi => kordi.registerTool({
      name: 'probe', description: 'Probe', parameters: { type: 'object' },
      execute: async (id, args, ctx) => {
        if (args.wait) await new Promise(resolve => setTimeout(resolve, 60000));
        ctx.reportProgress('working');
        return { content: [{ type: 'text', text: `${id}|${ctx.cwd}` }] };
      }
    });"#,
    )
    .unwrap();
    let (tools, _, _) = build_plugin_runtime(dir.path(), false, &[path])
        .await
        .unwrap();
    let tool = &tools[0];
    let chunks = Arc::new(AtomicUsize::new(0));
    let ctx = context(dir.path(), "model-call-1", chunks.clone());
    let result = tool
        .execute(serde_json::json!({}), &ctx, CancellationToken::new())
        .await
        .unwrap();
    assert!(format!("{result:?}").contains("model-call-1"));
    assert_eq!(chunks.load(Ordering::SeqCst), 1);

    let cancel = CancellationToken::new();
    let wait_ctx = context(dir.path(), "model-call-2", chunks.clone());
    let cancellation = async {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        cancel.cancel();
    };
    let (cancelled, ()) = tokio::join!(
        tool.execute(serde_json::json!({"wait": true}), &wait_ctx, cancel.clone()),
        cancellation,
    );
    assert!(cancelled.is_err());

    let next_ctx = context(dir.path(), "model-call-3", chunks.clone());
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tool.execute(serde_json::json!({}), &next_ctx, CancellationToken::new()),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(format!("{result:?}").contains("model-call-3"));
    assert_eq!(chunks.load(Ordering::SeqCst), 2);
}

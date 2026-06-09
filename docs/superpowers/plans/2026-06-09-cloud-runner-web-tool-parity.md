# Cloud Runner Web Tool Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Cloud agent runner `web_search` and `web_fetch` match the local tools while keeping local-computer-only tools excluded.

**Architecture:** The Cloud runner will derive `web_search` and `web_fetch` schemas from `kordi-tools` definitions and execute those same `kordi-tools` implementations inside a non-interactive Cloud sandbox `ToolContext`. Cloud policy remains the boundary layer for private URLs and owner-local resources before any network request is attempted.

**Tech Stack:** Rust, `kordi-cloud-agent-runner`, `kordi-tools`, `tokio`, `cargo test`, Kubernetes deployment on `takotako`.

---

## File Structure

- Modify `bridges/cloud-agent-runner/src/model_loop/prompt.rs`
  - Build model tool schemas from local `kordi_tools::{WebSearchTool, WebFetchTool}` definitions for parity.
  - Continue hand-defining sandbox/file/artifact tools.
- Modify `bridges/cloud-agent-runner/src/model_loop.rs`
  - Extract `url` arguments for `web_fetch`/`browser_fetch` policy checks.
  - Format `kordi-tools` text results as model-readable output.
- Modify `bridges/cloud-agent-runner/src/tools.rs`
  - Replace the `RemoteWebAllowed` placeholder with real execution for `web_search` and `web_fetch`.
  - Build a non-interactive `ToolContext` rooted in the Cloud sandbox workspace.
  - Keep private URL policy checks before execution.
- Modify `bridges/cloud-agent-runner/src/sandbox_client.rs`
  - Expose the Cloud sandbox root directory to construct `ToolContext.cwd` and `ToolContext.artifacts_dir`.
- Modify `bridges/cloud-agent-runner/tests/cloud_model_loop.rs`
  - Add schema parity tests.
  - Add model-loop test proving `web_fetch` executes and feeds fetched content back to the model.
- Modify `bridges/cloud-agent-runner/tests/cloud_tool_policy.rs` or `bridges/cloud-agent-runner/src/tools.rs` tests
  - Add executor-level test that private web URLs remain blocked.

---

### Task 1: Derive Cloud Web Tool Schemas from Local Tool Definitions

**Files:**
- Modify: `bridges/cloud-agent-runner/src/model_loop/prompt.rs`
- Test: `bridges/cloud-agent-runner/tests/cloud_model_loop.rs`

- [ ] **Step 1: Write the failing schema parity test**

Add imports near the top of `bridges/cloud-agent-runner/tests/cloud_model_loop.rs`:

```rust
use kordi_tools::{Tool, WebFetchTool, WebSearchTool};
```

Add this test before `model_loop_completes_text_response`:

```rust
#[test]
fn cloud_tool_catalog_uses_local_web_tool_definitions() {
    let catalog = kordi_cloud_agent_runner::model_loop::prompt::tool_catalog();
    let web_search = catalog
        .iter()
        .find(|tool| tool["function"]["name"] == "web_search")
        .expect("cloud catalog should expose web_search");
    let web_fetch = catalog
        .iter()
        .find(|tool| tool["function"]["name"] == "web_fetch")
        .expect("cloud catalog should expose web_fetch");

    let local_search = WebSearchTool.definition();
    let local_fetch = WebFetchTool.definition();

    assert_eq!(web_search["function"]["name"], local_search.name);
    assert_eq!(web_search["function"]["description"], local_search.description);
    assert_eq!(web_search["function"]["parameters"], local_search.parameters_schema);

    assert_eq!(web_fetch["function"]["name"], local_fetch.name);
    assert_eq!(web_fetch["function"]["description"], local_fetch.description);
    assert_eq!(web_fetch["function"]["parameters"], local_fetch.parameters_schema);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cargo test -p kordi-cloud-agent-runner --test cloud_model_loop cloud_tool_catalog_uses_local_web_tool_definitions -- --nocapture
```

Expected: FAIL because `web_search` and `web_fetch` are not in the Cloud catalog.

- [ ] **Step 3: Implement local-definition schema derivation**

In `bridges/cloud-agent-runner/src/model_loop/prompt.rs`, add:

```rust
use kordi_tools::{Tool, WebFetchTool, WebSearchTool};
```

Add helper:

```rust
fn local_tool_schema(tool: &dyn Tool) -> Value {
    let definition = tool.definition();
    json!({
        "type": "function",
        "function": {
            "name": definition.name,
            "description": definition.description,
            "parameters": definition.parameters_schema,
        }
    })
}
```

Update `tool_catalog()` to include these after `bash` and before `export_artifact`:

```rust
local_tool_schema(&WebSearchTool),
local_tool_schema(&WebFetchTool),
```

- [ ] **Step 4: Run schema parity test to verify it passes**

Run:

```bash
cargo test -p kordi-cloud-agent-runner --test cloud_model_loop cloud_tool_catalog_uses_local_web_tool_definitions -- --nocapture
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bridges/cloud-agent-runner/src/model_loop/prompt.rs bridges/cloud-agent-runner/tests/cloud_model_loop.rs
git commit -m "feat: derive cloud web tool schemas from local tools"
```

---

### Task 2: Execute Local `web_fetch` in the Cloud Runner

**Files:**
- Modify: `bridges/cloud-agent-runner/src/sandbox_client.rs`
- Modify: `bridges/cloud-agent-runner/src/tools.rs`
- Modify: `bridges/cloud-agent-runner/src/model_loop.rs`
- Test: `bridges/cloud-agent-runner/tests/cloud_model_loop.rs`

- [ ] **Step 1: Write the failing model-loop `web_fetch` execution test**

Add imports to `bridges/cloud-agent-runner/tests/cloud_model_loop.rs`:

```rust
use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;
```

Add helper near `sandbox_handle()`:

```rust
fn spawn_single_response_server(body: &'static str) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
    let addr = listener.local_addr().expect("local addr");
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept request");
        let mut request_buf = [0_u8; 2048];
        let _ = stream.read(&mut request_buf);
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        stream.write_all(response.as_bytes()).expect("write response");
        stream.flush().expect("flush response");
    });
    format!("http://{addr}/news")
}
```

Add test before `model_loop_exports_artifact_when_requested`:

```rust
#[tokio::test]
async fn model_loop_executes_local_web_fetch_tool_in_cloud_sandbox() {
    let client = RecordingClient::default();
    let url = spawn_single_response_server(
        "<html><head><title>OpenAI Test News</title></head><body><main><h1>OpenAI ships a test update</h1><p>Source text from controlled server.</p></main></body></html>",
    );
    let provider = FakeProvider::new(vec![
        ModelProviderResponse::ToolCalls(vec![ModelToolCall {
            id: "call_fetch".to_string(),
            name: "web_fetch".to_string(),
            arguments: json!({"url": url, "max_chars": 4000}),
        }]),
        ModelProviderResponse::FinalText("Fetched controlled OpenAI test news".to_string()),
    ]);

    let text = run_model_loop(
        &client,
        &provider,
        &run(),
        &sandbox_handle(),
        provider_auth(),
    )
    .await
    .unwrap();

    assert_eq!(text, "Fetched controlled OpenAI test news");
    let calls = provider.seen_messages.lock().unwrap();
    let final_context = calls.last().unwrap();
    let tool_message = final_context
        .iter()
        .find(|message| message["role"] == "tool" && message["name"] == "web_fetch")
        .expect("web_fetch tool output should be fed back to model");
    let content = tool_message["content"].as_str().unwrap();
    assert!(content.contains("Web Fetch"), "content was: {content}");
    assert!(content.contains("OpenAI ships a test update"), "content was: {content}");
    assert!(content.contains("Source text from controlled server"), "content was: {content}");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cargo test -p kordi-cloud-agent-runner --test cloud_model_loop model_loop_executes_local_web_fetch_tool_in_cloud_sandbox -- --nocapture
```

Expected: FAIL because `web_fetch` returns the placeholder `remote web access is allowed by policy` or is unavailable.

- [ ] **Step 3: Expose sandbox root for ToolContext**

In `bridges/cloud-agent-runner/src/sandbox_client.rs`, add a method to `LocalSandboxBackend` if one does not already exist:

```rust
impl LocalSandboxBackend {
    pub fn root(&self) -> &std::path::Path {
        &self.root
    }
}
```

For `SandboxBackendHandle`, add a helper function if needed:

```rust
pub fn sandbox_root(handle: &SandboxBackendHandle) -> std::path::PathBuf {
    handle.root().to_path_buf()
}
```

If `SandboxBackendHandle` is a type alias to `Arc<LocalSandboxBackend>`, use `handle.root().to_path_buf()` directly in `tools.rs`.

- [ ] **Step 4: Implement web tool execution through `kordi-tools`**

In `bridges/cloud-agent-runner/src/tools.rs`, add imports:

```rust
use kordi_tools::{
    ExecutionPolicy, Tool, ToolContext, ToolExecutionMode, ToolResult, WebFetchTool, WebSearchTool,
};
use tokio_util::sync::CancellationToken;
```

Remove the `RemoteWebAllowed` variant from `CloudToolOutput` or stop returning it.

Add helper:

```rust
fn cloud_tool_context(sandbox: &SandboxBackendHandle) -> ToolContext {
    let root = sandbox.root().to_path_buf();
    ToolContext {
        cwd: root.clone(),
        artifacts_dir: root,
        model: None,
        execution_policy: ExecutionPolicy::Safety,
        on_output: None,
        web_search: None,
        reach_out: None,
        reflection: None,
        task_operator: None,
        schedule_task: None,
        execution_mode: ToolExecutionMode::NonInteractive,
        request_approval: None,
    }
}

fn format_kordi_tool_result(result: ToolResult) -> String {
    result
        .content
        .into_iter()
        .map(|block| match block {
            kordi_core::types::ContentBlock::Text { text } => text,
            kordi_core::types::ContentBlock::Image { mime_type, .. } => {
                format!("[image result: {mime_type}]")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}
```

In `CloudToolExecutor::execute`, replace the `AllowRemoteWeb` placeholder branch with no early return; allow the later dispatch to handle web tools.

Add match arms:

```rust
"web_search" => {
    let ctx = cloud_tool_context(&self.sandbox);
    let result = WebSearchTool
        .execute(
            serde_json::from_str(content.unwrap_or_default()).unwrap_or_else(|_| serde_json::json!({})),
            &ctx,
            CancellationToken::new(),
        )
        .await
        .map_err(|err| CloudToolExecutionError::Blocked(err.to_string()))?;
    Ok(CloudToolOutput::Text(format_kordi_tool_result(result)))
}
"web_fetch" => {
    let ctx = cloud_tool_context(&self.sandbox);
    let result = WebFetchTool
        .execute(
            serde_json::from_str(content.unwrap_or_default()).unwrap_or_else(|_| serde_json::json!({})),
            &ctx,
            CancellationToken::new(),
        )
        .await
        .map_err(|err| CloudToolExecutionError::Blocked(err.to_string()))?;
    Ok(CloudToolOutput::Text(format_kordi_tool_result(result)))
}
```

If passing arguments through `content` is not appropriate, change `CloudToolExecutor::execute` signature to accept `arguments: &serde_json::Value` and pass `call.arguments.clone()` from `model_loop.rs`.

- [ ] **Step 5: Pass URL args and full JSON args from model loop**

In `bridges/cloud-agent-runner/src/model_loop.rs`, update `execute_model_tool` so `url_args` includes the URL for web tools:

```rust
let url_args = if matches!(call.name.as_str(), "web_fetch" | "browser_fetch") {
    call.arguments
        .get("url")
        .and_then(Value::as_str)
        .map(|url| vec![url])
        .unwrap_or_default()
} else {
    Vec::new()
};
```

Change executor call to pass `&call.arguments` if the signature changed:

```rust
.execute(request, Some(primary.as_str()), Some(content), &call.arguments)
```

- [ ] **Step 6: Run test to verify it passes**

Run:

```bash
cargo test -p kordi-cloud-agent-runner --test cloud_model_loop model_loop_executes_local_web_fetch_tool_in_cloud_sandbox -- --nocapture
```

Expected: PASS and tool output contains the controlled server content.

- [ ] **Step 7: Commit**

```bash
git add bridges/cloud-agent-runner/src/sandbox_client.rs bridges/cloud-agent-runner/src/tools.rs bridges/cloud-agent-runner/src/model_loop.rs bridges/cloud-agent-runner/tests/cloud_model_loop.rs
git commit -m "feat: execute local web_fetch in cloud runner"
```

---

### Task 3: Execute Local `web_search` and Preserve Cloud Safety Boundaries

**Files:**
- Modify: `bridges/cloud-agent-runner/src/tools.rs`
- Modify: `bridges/cloud-agent-runner/src/model_loop.rs`
- Test: `bridges/cloud-agent-runner/tests/cloud_tool_policy.rs`
- Test: `bridges/cloud-agent-runner/tests/cloud_model_loop.rs`

- [ ] **Step 1: Write a policy regression for blocked private `web_fetch`**

In `bridges/cloud-agent-runner/tests/cloud_tool_policy.rs`, add:

```rust
#[test]
fn web_fetch_private_url_is_blocked_in_cloud_runner() {
    let request = RunnerToolRequest {
        tool_name: "web_fetch",
        path_args: Vec::new(),
        url_args: vec!["http://127.0.0.1:1420/private"],
        requester_account_id: "acct_requester",
        owner_account_id: "acct_owner",
        data_owner_account_id: None,
    };

    assert_eq!(
        decide_runner_tool(&request),
        RunnerToolDecision::Block(RunnerToolBlockReason::PrivateNetwork)
    );
}
```

- [ ] **Step 2: Run private URL policy test**

Run:

```bash
cargo test -p kordi-cloud-agent-runner --test cloud_tool_policy web_fetch_private_url_is_blocked_in_cloud_runner -- --nocapture
```

Expected: PASS if policy already works; if it fails, fix `decide_web_urls` so private URL detection applies to `web_fetch` URL args.

- [ ] **Step 3: Write a `web_search` routing regression**

In `bridges/cloud-agent-runner/tests/cloud_model_loop.rs`, add this source-level regression to avoid brittle live DuckDuckGo assertions while proving the placeholder was removed:

```rust
#[test]
fn cloud_executor_routes_web_search_to_local_tool_not_placeholder() {
    let source = std::fs::read_to_string("src/tools.rs").expect("read cloud runner tools source");
    assert!(source.contains("WebSearchTool"));
    assert!(source.contains("WebFetchTool"));
    assert!(!source.contains("RemoteWebAllowed"));
    assert!(!source.contains("remote web access is allowed by policy"));
}
```

- [ ] **Step 4: Run web_search routing regression**

Run:

```bash
cargo test -p kordi-cloud-agent-runner --test cloud_model_loop cloud_executor_routes_web_search_to_local_tool_not_placeholder -- --nocapture
```

Expected: PASS after Task 2 removed the placeholder; FAIL if any placeholder remains.

- [ ] **Step 5: Run all runner tests**

Run:

```bash
cargo test -p kordi-cloud-agent-runner --test cloud_model_loop -- --nocapture
cargo test -p kordi-cloud-agent-runner --test cloud_tool_policy -- --nocapture
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add bridges/cloud-agent-runner/src/tools.rs bridges/cloud-agent-runner/src/model_loop.rs bridges/cloud-agent-runner/tests/cloud_tool_policy.rs bridges/cloud-agent-runner/tests/cloud_model_loop.rs
git commit -m "feat: route cloud web_search through local tool"
```

---

### Task 4: Deploy and Replay Dogfood Scheduled Task

**Files:**
- No code changes expected.
- Deployment target: `takotako`, namespace `kordi-cloud`.

- [ ] **Step 1: Run final local verification**

Run:

```bash
cargo test -p kordi-cloud-agent-runner --test cloud_model_loop -- --nocapture
cargo test -p kordi-cloud-agent-runner --test cloud_tool_policy -- --nocapture
cargo test -p kordi-cloud-server --test scheduled_task_tool_e2e -- --nocapture
```

Expected: all tests PASS.

- [ ] **Step 2: Push branch**

```bash
git push
```

Expected: branch pushes cleanly.

- [ ] **Step 3: Sync and deploy Cloud runner**

Run:

```bash
export KORDI_CLOUD_SSH_TARGET='shu_yang@takotako'
export KORDI_CLOUD_SSH_ZONE='us-central1-c'
export KORDI_CLOUD_REMOTE_DIR='$HOME/kordi-cloud-server-deploy'
bash bridges/cloud-server/deploy/sync-and-build.sh
export KORDI_CLOUD_RUNNER_IMAGE_TAG="runner-scheduled-tool-559-$(git rev-parse --short HEAD)"
bash bridges/cloud-server/deploy/k3s/deploy-cloud-agent-runner.sh
```

Expected: `deployment "kordi-cloud-agent-runner" successfully rolled out` and image tag matches the current commit.

- [ ] **Step 4: Replay the failed scheduled OpenAI task**

Run the DB update to make the task due once:

```bash
gcloud compute ssh shu_yang@takotako --zone us-central1-c --command "kubectl exec -i -n kordi-cloud postgres-0 -- bash -lc 'cat > /tmp/replay_web_tools.sql <<'\''SQL'\''
UPDATE scheduled_tool_tasks
SET next_run_at = to_char((now() AT TIME ZONE \$q\$UTC\$q\$) - interval \$q\$10 seconds\$q\$, \$q\$YYYY-MM-DD\$q\$) || \$q\$T\$q\$ || to_char((now() AT TIME ZONE \$q\$UTC\$q\$) - interval \$q\$10 seconds\$q\$, \$q\$HH24:MI:SS.US\$q\$) || \$q\$+00:00\$q\$,
    updated_at = to_char((now() AT TIME ZONE \$q\$UTC\$q\$), \$q\$YYYY-MM-DD\$q\$) || \$q\$T\$q\$ || to_char((now() AT TIME ZONE \$q\$UTC\$q\$), \$q\$HH24:MI:SS.US\$q\$) || \$q\$+00:00\$q\$
WHERE task_id = \$q\$scheduled_task_4696f7e3c7a44a24b0852f439e8226a5\$q\$
RETURNING task_id,next_run_at,last_run_status,last_run_error;
SQL
PGPASSWORD=\$POSTGRES_PASSWORD psql -U \$POSTGRES_USER -d \$POSTGRES_DB -P pager=off -f /tmp/replay_web_tools.sql'"
```

Expected: row updated and `next_run_at` is in the past.

- [ ] **Step 5: Monitor completion**

Run after 1-3 minutes:

```bash
gcloud compute ssh shu_yang@takotako --zone us-central1-c --command "kubectl exec -i -n kordi-cloud postgres-0 -- bash -lc 'cat > /tmp/monitor_web_tools.sql <<'\''SQL'\''
SELECT task_id,next_run_at,last_run_at,last_run_status,last_run_error,updated_at
FROM scheduled_tool_tasks
WHERE task_id=\$q\$scheduled_task_4696f7e3c7a44a24b0852f439e8226a5\$q\$;

SELECT run_id,status,target_runtime,due_at,created_at,updated_at,completed_at,error_code,error_message,result_message
FROM scheduled_tool_task_runs
WHERE task_id=\$q\$scheduled_task_4696f7e3c7a44a24b0852f439e8226a5\$q\$
ORDER BY created_at DESC LIMIT 3;

SELECT run_id,status,response_message_id,created_at,updated_at,completed_at,error_code,error_message
FROM cloud_agent_fallback_runs
WHERE request_message_id IN (
  SELECT run_id FROM scheduled_tool_task_runs WHERE task_id=\$q\$scheduled_task_4696f7e3c7a44a24b0852f439e8226a5\$q\$
)
ORDER BY created_at DESC LIMIT 3;
SQL
PGPASSWORD=\$POSTGRES_PASSWORD psql -U \$POSTGRES_USER -d \$POSTGRES_DB -P pager=off -f /tmp/monitor_web_tools.sql'"
```

Expected: latest scheduled run and fallback run are `completed`; response message exists in session `8b909362-0c0a-49fd-a9cd-06e1f9e7cc53` and should include web research with links rather than the previous sandbox limitation text.

- [ ] **Step 6: Comment on PR**

Run:

```bash
gh pr comment 559 --body "Cloud runner web tool parity implemented: web_search/web_fetch now derive schemas from local kordi-tools and execute the same local tool implementations in Cloud sandbox. Deployed runner image: docker.io/library/kordi-cloud-agent-runner:runner-scheduled-tool-559-<commit>. Replayed scheduled OpenAI task and verified latest run completed."
```

Expected: comment URL returned.

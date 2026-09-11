//! Owner-only access to existing macOS application sessions through Apple's JXA bridge.
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use kordi_core::error::{KordiError, KordiResult};
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::{
    ExecutionPolicy, Tool, ToolContext, ToolMetadata, ToolResult, ToolRiskLevel, ToolScheduling,
};

const LIST_SCRIPT: &str = r#"ObjC.import('AppKit');
var apps = $.NSWorkspace.sharedWorkspace.runningApplications;
var result = [];
for (var i = 0; i < apps.count; i++) {
    var app = apps.objectAtIndex(i);
    if (Number(app.activationPolicy) === 0) result.push({
        name: ObjC.unwrap(app.localizedName), bundleId: ObjC.unwrap(app.bundleIdentifier),
        pid: Number(app.processIdentifier), active: String(app.active) === 'true' || String(app.active) === '1'
    });
}
JSON.stringify(result);"#;

pub struct LocalAppTool;

#[async_trait]
impl Tool for LocalAppTool {
    fn name(&self) -> &str {
        "local_app"
    }

    fn description(&self) -> &str {
        "Use existing applications on the owner's Mac. First use action=list to discover running apps and bundle IDs. Then action=script runs JavaScript for Automation (JXA, not browser JavaScript) with app bound to Application(bundle_id). Use app's scripting dictionary to inspect or operate documents and existing signed-in Safari/Chrome tabs; use Application('System Events') for accessibility UI when necessary. Return a JSON-serializable value explicitly. Do not assume browser_fetch shares these app sessions. OS Automation/Accessibility permissions may be required. Owner YOLO only; never available for non-owner shared requests."
    }

    fn parameters_schema(&self) -> Value {
        json!({"type":"object","properties":{
            "action":{"type":"string","enum":["list","script"]},
            "bundle_id":{"type":"string","description":"Exact bundle ID from list; required for script."},
            "script":{"type":"string","description":"JXA function body. app is the selected Application. Return a value, e.g. return app.name();"}
        },"required":["action"],"additionalProperties":false})
    }

    fn metadata(&self) -> ToolMetadata {
        ToolMetadata::execution(ToolRiskLevel::High)
    }

    fn scheduling(&self, _params: &Value, _ctx: &ToolContext) -> ToolScheduling {
        ToolScheduling::MutatingUnknown
    }

    async fn execute(
        &self,
        params: Value,
        ctx: &ToolContext,
        cancel: CancellationToken,
    ) -> KordiResult<ToolResult> {
        // Enforce here as well as in the shared tool scheduler.
        if ctx.execution_policy != ExecutionPolicy::Yolo {
            return Err(KordiError::Tool(
                "Local application automation requires an owner request with YOLO enabled.".into(),
            ));
        }
        if !cfg!(target_os = "macos") {
            return Err(KordiError::Tool(
                "Local application automation is available only on macOS.".into(),
            ));
        }
        let script = script_for_request(&params)?;
        let mut child = Command::new("/usr/bin/osascript")
            .args(["-l", "JavaScript", "-e", &script])
            .current_dir(&ctx.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| {
                KordiError::Tool("Could not start macOS application automation.".into())
            })?;
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        // Bound capture while still draining pipes so large app responses cannot deadlock.
        let stdout = tokio::spawn(capture_output(stdout));
        let stderr = tokio::spawn(capture_output(stderr));
        let status = tokio::select! {
            _ = cancel.cancelled() => None,
            result = tokio::time::timeout(Duration::from_secs(20), child.wait()) => {
                match result { Ok(Ok(status)) => Some(status), _ => None }
            }
        };
        if status.is_none() {
            let _ = child.kill().await;
            let _ = child.wait().await;
            stdout.abort();
            stderr.abort();
            return Err(KordiError::Tool(if cancel.is_cancelled() {
                "Local application operation cancelled.".into()
            } else {
                "Local application operation timed out. Check whether macOS is waiting for an Automation or Accessibility permission grant.".into()
            }));
        }
        let (output, truncated) = stdout
            .await
            .map_err(|_| KordiError::Tool("Application output unavailable.".into()))?;
        let (error, _) = stderr
            .await
            .map_err(|_| KordiError::Tool("Application error output unavailable.".into()))?;
        let succeeded = status.is_some_and(|status| status.success());
        let text = if succeeded {
            output
        } else {
            format!(
                "macOS application operation failed: {error}\nIf macOS reports an authorization denial, grant the requesting Kordi app access under System Settings > Privacy & Security > Automation or Accessibility. This is an OS permission, not a Kordi approval."
            )
        };
        Ok(crate::support::text_result_with(
            text,
            Some(json!({
                "executionLocation":"local", "action":params["action"],
                "bundleId":params.get("bundle_id"), "truncated":truncated,
            })),
            !succeeded,
            None,
        ))
    }
}

fn script_for_request(params: &Value) -> KordiResult<String> {
    match params.get("action").and_then(Value::as_str) {
        Some("list") => Ok(LIST_SCRIPT.into()),
        Some("script") => {
            let id = params
                .get("bundle_id")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| {
                    KordiError::Tool(
                        "bundle_id is required; discover the app with action=list first.".into(),
                    )
                })?;
            let script = params
                .get("script")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty() && s.len() <= 32_768)
                .ok_or_else(|| {
                    KordiError::Tool(
                        "A non-empty JXA script of at most 32768 bytes is required.".into(),
                    )
                })?;
            let id = serde_json::to_string(id).map_err(|e| KordiError::Tool(e.to_string()))?;
            Ok(format!(
                "var app = Application({id});\nif (!app.running()) throw new Error('Target application is not running; refresh action=list.');\nvar result = (function(app) {{\n{script}\n}})(app);\nJSON.stringify(result === undefined ? null : result);"
            ))
        }
        _ => Err(KordiError::Tool("action must be list or script.".into())),
    }
}

async fn capture_output(mut stream: impl tokio::io::AsyncRead + Unpin) -> (String, bool) {
    const LIMIT: usize = 48 * 1024;
    let mut captured = Vec::new();
    let mut buffer = [0; 4096];
    let mut truncated = false;
    while let Ok(size) = stream.read(&mut buffer).await {
        if size == 0 {
            break;
        }
        let take = size.min(LIMIT - captured.len());
        captured.extend_from_slice(&buffer[..take]);
        truncated |= take < size;
    }
    (String::from_utf8_lossy(&captured).into_owned(), truncated)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn application_identity_is_data_not_javascript() {
        let script = script_for_request(&json!({"action":"script","bundle_id":"test\"); throw new Error('injected'); //","script":"return app.name();"})).unwrap();
        assert!(script.contains("Application(\"test\\\"); throw"));
        assert!(!LocalAppTool.allows_shared_requests());
        assert!(script_for_request(&json!({"action":"script","script":"return 1"})).is_err());
    }
    #[tokio::test]
    async fn app_output_is_bounded() {
        let bytes = vec![b'x'; 100_000];
        let (text, truncated) = capture_output(bytes.as_slice()).await;
        assert_eq!(text.len(), 48 * 1024);
        assert!(truncated);
    }
}

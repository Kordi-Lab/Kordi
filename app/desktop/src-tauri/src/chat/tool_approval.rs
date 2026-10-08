//! Mac approval prompt for connector `act` tools (issue 1712, PR 5).
//!
//! The desktop runtime's `ToolContext.request_approval` hook lands here. A
//! connector `act` call pauses the turn, the webview shows an inline card
//! from the `desktop_tool_approval_request` event, and the person answers
//! through `desktop_tool_approval_respond`. No answer within five minutes
//! counts as "Not now". Open prompts stay here until answered, so a webview
//! that mounts later reads them with `desktop_tool_approval_pending`. The
//! hook is built per turn from the lease's `act` tools; any other tool that
//! asks for approval is refused, exactly as before this hook existed.
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use kordi_cli::desktop_runtime::DesktopCloudExecutionLease;
use kordi_tools::{
    RequestToolApprovalFn, ToolApprovalDecision, ToolApprovalOutcome, ToolApprovalRequest,
};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::Emitter;
use tokio::sync::oneshot;

pub(crate) const REQUEST_EVENT: &str = "desktop_tool_approval_request";
pub(crate) const RESOLVED_EVENT: &str = "desktop_tool_approval_resolved";
pub(crate) const APPROVAL_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Upper bound for the arguments sent to the card; larger calls are cut
/// string by string and marked `argsTruncated`.
pub(crate) const MAX_ARGS_BYTES: usize = 16 * 1024;

/// Which conversation and agent the turn belongs to.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApprovalContext {
    pub session_id: String,
    pub conversation_title: Option<String>,
    pub agent_name: Option<String>,
}

/// What the webview shows: never a credential, only the call itself.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApprovalPrompt {
    pub request_id: String,
    pub tool: String,
    /// The tool's description, for example "Send an email."
    pub summary: String,
    /// The connector's provider id, for example `gmail`.
    pub connector: String,
    /// The call's arguments, at most [`MAX_ARGS_BYTES`] when serialized.
    pub args: Value,
    /// True when `args` is shorter than what the agent sent.
    pub args_truncated: bool,
    #[serde(flatten)]
    pub context: ApprovalContext,
}

impl ApprovalPrompt {
    fn new(
        request_id: String,
        request: &ToolApprovalRequest,
        provider: &str,
        context: &ApprovalContext,
    ) -> Self {
        let (args, args_truncated) = bounded_args(&request.command);
        Self {
            request_id,
            tool: request.tool_name.clone(),
            summary: request.reason.clone(),
            connector: provider.to_string(),
            args,
            args_truncated,
            context: context.clone(),
        }
    }
}

fn shorten_strings(value: &Value, max_chars: usize) -> Value {
    match value {
        Value::String(text) if text.chars().count() > max_chars => Value::String(format!(
            "{}…",
            text.chars().take(max_chars).collect::<String>()
        )),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| shorten_strings(item, max_chars))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| (key.clone(), shorten_strings(item, max_chars)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn serialized_len(value: &Value) -> usize {
    serde_json::to_vec(value).map_or(usize::MAX, |bytes| bytes.len())
}

/// The call's arguments for the card, within [`MAX_ARGS_BYTES`], and whether
/// anything was cut. Every key stays; only long text values get shorter.
pub(crate) fn bounded_args(command: &str) -> (Value, bool) {
    let parsed = serde_json::from_str::<Value>(command)
        .unwrap_or_else(|_| Value::String(command.to_string()));
    if serialized_len(&parsed) <= MAX_ARGS_BYTES {
        return (parsed, false);
    }
    for max_chars in [4096, 1024, 256, 64] {
        let shortened = shorten_strings(&parsed, max_chars);
        if serialized_len(&shortened) <= MAX_ARGS_BYTES {
            return (shortened, true);
        }
    }
    let mut end = MAX_ARGS_BYTES.min(command.len());
    while !command.is_char_boundary(end) {
        end -= 1;
    }
    (Value::String(format!("{}…", &command[..end])), true)
}

pub(crate) type Emit = Arc<dyn Fn(&str, Value) -> bool + Send + Sync>;
/// `act` tool name to provider id, from this turn's lease.
pub(crate) type ActTools = HashMap<String, String>;

/// The lease's `act` tools that may ask the person, filtered like the
/// connector tools themselves: a connector-shaped name that is never a
/// built-in or other host tool.
pub(crate) fn act_tools_for_lease(lease: Option<&DesktopCloudExecutionLease>) -> ActTools {
    lease
        .and_then(|lease| lease.connector_tools.as_deref())
        .map(kordi_tools::connector_tools::act_tool_providers)
        .unwrap_or_default()
}

struct Pending {
    order: u64,
    prompt: ApprovalPrompt,
    sender: oneshot::Sender<bool>,
}

/// Open prompts by request id.
#[derive(Default)]
pub(crate) struct ApprovalBroker {
    pending: Mutex<HashMap<String, Pending>>,
    next: AtomicU64,
}

fn decision(approved: bool) -> ToolApprovalOutcome {
    ToolApprovalOutcome {
        decision: if approved {
            ToolApprovalDecision::ApprovedOnce
        } else {
            ToolApprovalDecision::Denied
        },
    }
}

impl ApprovalBroker {
    /// Asks the person and waits for an answer, at most `timeout`.
    pub(crate) async fn request(
        &self,
        emit: &Emit,
        act_tools: &ActTools,
        context: &ApprovalContext,
        request: ToolApprovalRequest,
        timeout: Duration,
    ) -> ToolApprovalOutcome {
        let Some(provider) = act_tools.get(&request.tool_name) else {
            return decision(false);
        };
        let request_id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        let prompt = ApprovalPrompt::new(request_id.clone(), &request, provider, context);
        let payload = serde_json::to_value(&prompt).unwrap_or(Value::Null);
        let order = self.next.fetch_add(1, Ordering::Relaxed);
        self.lock().insert(
            request_id.clone(),
            Pending {
                order,
                prompt,
                sender,
            },
        );
        let shown = emit(REQUEST_EVENT, payload);
        let approved =
            shown && matches!(tokio::time::timeout(timeout, receiver).await, Ok(Ok(true)));
        self.lock().remove(&request_id);
        emit(
            RESOLVED_EVENT,
            json!({ "requestId": request_id, "approved": approved }),
        );
        decision(approved)
    }

    /// Delivers the person's answer. False when the prompt is gone.
    pub(crate) fn respond(&self, request_id: &str, approved: bool) -> bool {
        self.lock()
            .remove(request_id)
            .is_some_and(|pending| pending.sender.send(approved).is_ok())
    }

    /// Prompts still waiting for an answer, oldest first.
    pub(crate) fn pending(&self) -> Vec<ApprovalPrompt> {
        let pending = self.lock();
        let mut open = pending.values().collect::<Vec<_>>();
        open.sort_by_key(|pending| pending.order);
        open.into_iter()
            .map(|pending| pending.prompt.clone())
            .collect()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Pending>> {
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

static BROKER: OnceLock<ApprovalBroker> = OnceLock::new();
static EMIT: OnceLock<Emit> = OnceLock::new();

fn broker() -> &'static ApprovalBroker {
    BROKER.get_or_init(ApprovalBroker::default)
}

/// Called once from the app setup so prompts can reach the webview.
pub(crate) fn install(app: tauri::AppHandle) {
    let _ = EMIT.set(Arc::new(move |event, payload| {
        app.emit(event, payload).is_ok()
    }));
}

/// The hook for `ToolContext.request_approval` on a turn whose lease lists
/// `act_tools`; `None` when there are none or before `install`.
pub(crate) fn hook(act_tools: ActTools, context: ApprovalContext) -> Option<RequestToolApprovalFn> {
    if act_tools.is_empty() {
        return None;
    }
    let emit = EMIT.get()?.clone();
    let shared = Arc::new((act_tools, context));
    Some(Arc::new(move |request| {
        let (emit, shared) = (emit.clone(), shared.clone());
        Box::pin(async move {
            let (act_tools, context) = &*shared;
            broker()
                .request(&emit, act_tools, context, request, APPROVAL_TIMEOUT)
                .await
        })
    }))
}

#[tauri::command]
pub(crate) fn desktop_tool_approval_respond(request_id: String, approved: bool) -> bool {
    broker().respond(request_id.trim(), approved)
}

/// Open prompts, for a webview that mounts or regains focus after a
/// `desktop_tool_approval_request` event was sent.
#[tauri::command]
pub(crate) fn desktop_tool_approval_pending() -> Vec<ApprovalPrompt> {
    broker().pending()
}

#[cfg(test)]
#[path = "tool_approval_tests.rs"]
mod tests;

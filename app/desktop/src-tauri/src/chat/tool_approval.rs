//! Mac approval prompt for connector `act` tools (issue 1712, PR 5).
//!
//! The desktop runtime's `ToolContext.request_approval` hook lands here. A
//! connector `act` call pauses the turn, the webview shows an inline card
//! from the `desktop_tool_approval_request` event, and the person answers
//! through `desktop_tool_approval_respond`. No answer within five minutes
//! counts as "Not now". Every other tool that asks for approval is refused,
//! exactly as before this hook existed.
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use kordi_tools::connector_tools::is_connector_tool_name;
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

/// What the webview shows: never a credential, only the call itself.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApprovalPrompt {
    pub request_id: String,
    pub tool: String,
    /// The tool's description, for example "Send an email."
    pub summary: String,
    /// The tool's namespace, for example `gmail` for `gmail.send`.
    pub connector: String,
    pub args: Value,
}

impl ApprovalPrompt {
    fn new(request_id: String, request: &ToolApprovalRequest) -> Self {
        let connector = request
            .tool_name
            .split_once('.')
            .map(|(prefix, _)| prefix.to_string())
            .unwrap_or_default();
        Self {
            request_id,
            tool: request.tool_name.clone(),
            summary: request.reason.clone(),
            connector,
            args: serde_json::from_str(&request.command).unwrap_or(Value::Null),
        }
    }
}

pub(crate) type Emit = Arc<dyn Fn(&str, Value) -> bool + Send + Sync>;

/// Pending prompts by request id.
#[derive(Default)]
pub(crate) struct ApprovalBroker {
    pending: Mutex<HashMap<String, oneshot::Sender<bool>>>,
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
        request: ToolApprovalRequest,
        timeout: Duration,
    ) -> ToolApprovalOutcome {
        if !is_connector_tool_name(&request.tool_name) {
            return decision(false);
        }
        let request_id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        self.lock().insert(request_id.clone(), sender);
        let prompt = ApprovalPrompt::new(request_id.clone(), &request);
        let shown = emit(
            REQUEST_EVENT,
            serde_json::to_value(&prompt).unwrap_or(Value::Null),
        );
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
            .is_some_and(|sender| sender.send(approved).is_ok())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, oneshot::Sender<bool>>> {
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

/// The hook for `ToolContext.request_approval`; `None` before `install`.
pub(crate) fn hook() -> Option<RequestToolApprovalFn> {
    let emit = EMIT.get()?.clone();
    Some(Arc::new(move |request| {
        let emit = emit.clone();
        Box::pin(async move { broker().request(&emit, request, APPROVAL_TIMEOUT).await })
    }))
}

#[tauri::command]
pub(crate) fn desktop_tool_approval_respond(request_id: String, approved: bool) -> bool {
    broker().respond(request_id.trim(), approved)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(tool: &str) -> ToolApprovalRequest {
        ToolApprovalRequest {
            tool_name: tool.into(),
            title: format!("Allow {tool} to act in gmail"),
            command: r#"{"to":"a@example.com"}"#.into(),
            reason: "Send an email.".into(),
        }
    }

    type Events = Arc<Mutex<Vec<(String, Value)>>>;

    /// A fake webview: records events and answers each prompt with `answer`.
    fn responder(broker: Arc<ApprovalBroker>, answer: Option<bool>) -> (Emit, Events) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let seen = events.clone();
        let emit: Emit = Arc::new(move |event, payload: Value| {
            seen.lock()
                .unwrap()
                .push((event.to_string(), payload.clone()));
            if let (REQUEST_EVENT, Some(approved)) = (event, answer) {
                let broker = broker.clone();
                let id = payload["requestId"].as_str().unwrap().to_string();
                tokio::spawn(async move {
                    assert!(broker.respond(&id, approved));
                });
            }
            true
        });
        (emit, events)
    }

    #[tokio::test]
    async fn the_person_answers_through_the_respond_command() {
        let broker = Arc::new(ApprovalBroker::default());
        let (emit, events) = responder(broker.clone(), Some(true));
        let outcome = broker
            .request(&emit, request("gmail.send"), Duration::from_secs(5))
            .await;
        assert!(outcome.approved());
        let events = events.lock().unwrap().clone();
        assert_eq!(events[0].0, REQUEST_EVENT);
        assert_eq!(events[0].1["tool"], "gmail.send");
        assert_eq!(events[0].1["summary"], "Send an email.");
        assert_eq!(events[0].1["connector"], "gmail");
        assert_eq!(events[0].1["args"]["to"], "a@example.com");
        assert_eq!(events[1].0, RESOLVED_EVENT);
        assert_eq!(events[1].1["approved"], true);

        let (emit, _) = responder(broker.clone(), Some(false));
        let outcome = broker
            .request(&emit, request("gmail.send"), Duration::from_secs(5))
            .await;
        assert!(!outcome.approved());
        assert!(broker.lock().is_empty());
    }

    #[tokio::test]
    async fn no_answer_in_time_denies_and_late_answers_are_ignored() {
        let broker = Arc::new(ApprovalBroker::default());
        let (emit, events) = responder(broker.clone(), None);
        let outcome = broker
            .request(&emit, request("gmail.send"), Duration::from_millis(20))
            .await;
        assert!(!outcome.approved());
        let id = events.lock().unwrap()[0].1["requestId"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(!broker.respond(&id, true), "the prompt expired");
        assert_eq!(events.lock().unwrap()[1].1["approved"], false);
    }

    #[tokio::test]
    async fn only_connector_tools_are_prompted() {
        let broker = Arc::new(ApprovalBroker::default());
        let (emit, events) = responder(broker.clone(), Some(true));
        let outcome = broker
            .request(&emit, request("bash"), Duration::from_secs(5))
            .await;
        assert!(!outcome.approved());
        assert!(events.lock().unwrap().is_empty());
        // A webview that cannot be reached denies at once.
        let unreachable: Emit = Arc::new(|_, _| false);
        let outcome = broker
            .request(&unreachable, request("gmail.send"), Duration::from_secs(5))
            .await;
        assert!(!outcome.approved());
    }
}

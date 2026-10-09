//! Connector tools for a desktop turn that runs under a cloud execution
//! lease (issue 1712). The server delivered the descriptors with the lease;
//! each call goes back to the server broker with the lease and claim ids,
//! authenticated with the signed-in desktop session. The broker holds every
//! provider credential and returns only the tool result.
use std::sync::Arc;

use kordi_cli::desktop_runtime::DesktopCloudExecutionLease;
use kordi_core::error::KordiError;
use kordi_tools::connector_tools::{
    is_connector_tool_name, is_reserved_tool_name, ConnectorCallFuture, ConnectorToolDescriptor,
    ConnectorToolsRuntime,
};
use serde_json::{json, Value};

const BROKER_CALL_PATH: &str = "/internal/connectors/call";
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

/// Rebuilt every turn. `None` for a shared lease without connector tools,
/// and when the desktop is signed out.
pub(super) fn build(lease: &DesktopCloudExecutionLease) -> Option<ConnectorToolsRuntime> {
    let offer_request_connect = lease_is_owner_private(lease);
    let descriptors = lease_descriptors(lease).unwrap_or_default();
    if descriptors.is_empty() && !offer_request_connect {
        return None;
    }
    let session = crate::cloud_session::cloud_session_load().ok()??;
    if session.token.trim().is_empty() || session.account_id != lease.owner_account_id {
        return None;
    }
    let api_base = crate::cloud_api_base_url_from_env().ok()?;
    let mut runtime = http_runtime(descriptors, lease, api_base, session.token);
    runtime.offer_request_connect = offer_request_connect;
    Some(runtime)
}

/// The owner's own local turn: no lease and no connector data, only the
/// `connectors_request_connect` link.
pub(super) fn owner_local() -> ConnectorToolsRuntime {
    ConnectorToolsRuntime {
        descriptors: Vec::new(),
        call: Arc::new(|_, _| {
            Box::pin(async {
                Err(KordiError::Tool(
                    kordi_tools::connector_tools::CONNECTOR_TOOLS_UNAVAILABLE.into(),
                ))
            })
        }),
        report_declined: None,
        offer_request_connect: true,
    }
}

fn lease_is_owner_private(lease: &DesktopCloudExecutionLease) -> bool {
    lease.connector_audience.as_deref() == Some("owner_private")
}

/// Connector-shaped descriptors from the lease; `None` when there are none.
fn lease_descriptors(lease: &DesktopCloudExecutionLease) -> Option<Vec<ConnectorToolDescriptor>> {
    let descriptors = lease
        .connector_tools
        .as_ref()?
        .iter()
        .filter(|descriptor| {
            is_connector_tool_name(&descriptor.name) && !is_reserved_tool_name(&descriptor.name)
        })
        .cloned()
        .collect::<Vec<_>>();
    (!descriptors.is_empty()).then_some(descriptors)
}

fn broker_body(
    lease: &DesktopCloudExecutionLease,
    tool: &ConnectorToolDescriptor,
    args: Value,
) -> Value {
    json!({
        "leaseId": lease.run_id,
        "claimId": lease.claim_id,
        "connectorId": tool.connector_id,
        "tool": tool.name,
        "args": args,
    })
}

/// Body that records the person's "Not now" as a `denied` audit row.
fn declined_body(lease: &DesktopCloudExecutionLease, tool: &ConnectorToolDescriptor) -> Value {
    let mut body = broker_body(lease, tool, json!({}));
    body["declinedByOwner"] = json!(true);
    body
}

/// Account route that records a decline without a lease, for a lease that
/// lapsed while the card was open. `None` for an id that is not path-safe.
fn declined_audit_path(connector_id: &str) -> Option<String> {
    let safe = !connector_id.is_empty()
        && connector_id.len() <= 128
        && connector_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-');
    safe.then(|| format!("/v1/cloud/connectors/{connector_id}/audit/declined"))
}

fn declined_audit_body(
    lease: &DesktopCloudExecutionLease,
    tool: &ConnectorToolDescriptor,
) -> Value {
    json!({ "tool": tool.name, "summary": tool.description, "runId": lease.run_id })
}

type PostFn = Arc<dyn Fn(String, Value) -> ConnectorCallFuture + Send + Sync>;

/// Records a decline: on the lease through the broker, which answers
/// `declined_by_owner` once the row is written, or else through the account
/// route, so a lease that lapsed during the wait still leaves the row.
async fn report_declined(
    post: PostFn,
    lease: DesktopCloudExecutionLease,
    tool: ConnectorToolDescriptor,
) {
    let on_lease = post(BROKER_CALL_PATH.to_string(), declined_body(&lease, &tool)).await;
    if matches!(&on_lease, Err(error) if error.to_string().contains("(declined_by_owner)")) {
        return;
    }
    if let Some(path) = declined_audit_path(&tool.connector_id) {
        if let Err(error) = post(path, declined_audit_body(&lease, &tool)).await {
            eprintln!(
                "[connectors] could not record the decline of {}: {error}",
                tool.name
            );
        }
    }
}

fn broker_result(status: u16, bytes: &[u8]) -> Result<Value, KordiError> {
    let body: Value = serde_json::from_slice(bytes)
        .map_err(|_| KordiError::Tool(format!("The connector broker returned HTTP {status}.")))?;
    if body["ok"] == true {
        if let Some(result) = body.get("result") {
            return Ok(result.clone());
        }
    }
    let message = body["error"]["message"]
        .as_str()
        .unwrap_or("The connector call failed.");
    let code = body["error"]["code"].as_str().unwrap_or("unknown");
    Err(KordiError::Tool(format!("{message} ({code})")))
}

fn http_runtime(
    descriptors: Vec<ConnectorToolDescriptor>,
    lease: &DesktopCloudExecutionLease,
    api_base: String,
    token: String,
) -> ConnectorToolsRuntime {
    let post: PostFn = Arc::new(move |path: String, body: Value| {
        let (api_base, token) = (api_base.clone(), token.clone());
        Box::pin(async move { post_broker(&api_base, &token, &path, &body).await })
            as ConnectorCallFuture
    });
    let (call_lease, call_post) = (lease.clone(), post.clone());
    let declined_lease = lease.clone();
    ConnectorToolsRuntime {
        descriptors,
        call: Arc::new(move |tool, args| {
            call_post(
                BROKER_CALL_PATH.to_string(),
                broker_body(&call_lease, &tool, args),
            )
        }),
        report_declined: Some(Arc::new(move |tool| {
            Box::pin(report_declined(post.clone(), declined_lease.clone(), tool))
        })),
        offer_request_connect: false,
    }
}

async fn post_broker(
    api_base: &str,
    token: &str,
    path: &str,
    body: &Value,
) -> Result<Value, KordiError> {
    let unavailable = || KordiError::Tool("The connector broker could not be reached.".into());
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| unavailable())?;
    let mut response = client
        .post(format!("{}{path}", api_base.trim_end_matches('/')))
        .bearer_auth(token)
        .json(body)
        .send()
        .await
        .map_err(|_| unavailable())?;
    let status = response.status().as_u16();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| unavailable())? {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(KordiError::Tool(
                "The connector result was too large.".into(),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    broker_result(status, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lease(connector_tools: Option<Value>) -> DesktopCloudExecutionLease {
        let mut value = json!({
            "sessionId": "session:direct-person:a:b",
            "runId": "car_1",
            "claimId": "8f8e6a52-41e4-4c42-9d1e-4c9a3a1f1a10",
            "ownerAccountId": "acct_owner",
        });
        if let Some(tools) = connector_tools {
            value["connectorTools"] = tools;
        }
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn a_lease_without_connector_tools_yields_none() {
        assert!(lease(None).connector_tools.is_none());
        assert!(build(&lease(None)).is_none());
        assert!(lease_descriptors(&lease(None)).is_none());
        assert!(lease_descriptors(&lease(Some(json!([])))).is_none());
        // Names that fail the provider function-name shape never register.
        // (A name that collides with a built-in tool is skipped by the tool
        // registry, which never replaces an existing tool.)
        let odd = lease(Some(
            json!([{"connectorId":"c","provider":"p","name":"gmail.search",
            "group":"read","description":"d"}]),
        ));
        assert!(lease_descriptors(&odd).is_none());
    }

    #[test]
    fn a_bad_lease_entry_drops_only_itself() {
        let lease = lease(Some(json!([
            {"connectorId":"conn_1","provider":"gmail","name":"gmail_search","group":"read",
             "description":"Search mail."},
            {"connectorId":"conn_1","provider":"gmail","name":"gmail_watch","group":"stream",
             "description":"Unknown group."},
            42,
            {"connectorId":"conn_1","provider":"gmail","name":"gmail_send","group":"act",
             "description":"Send mail."}
        ])));
        let names = lease_descriptors(&lease)
            .unwrap()
            .into_iter()
            .map(|descriptor| descriptor.name)
            .collect::<Vec<_>>();
        assert_eq!(names, ["gmail_search", "gmail_send"]);
    }

    #[test]
    fn lease_descriptors_and_broker_calls_carry_only_ids() {
        let lease = lease(Some(json!([
            {"connectorId":"conn_1","provider":"gmail","name":"gmail_search","group":"read",
             "description":"Search mail.","inputSchema":{"type":"object"}},
            {"connectorId":"conn_1","provider":"gmail","name":"gmail_send","group":"act",
             "description":"Send mail."}
        ])));
        let descriptors = lease_descriptors(&lease).unwrap();
        assert_eq!(descriptors.len(), 2);
        let runtime = http_runtime(
            descriptors.clone(),
            &lease,
            "https://kordi.test".into(),
            "kordi_cs_test".into(),
        );
        assert_eq!(runtime.descriptors, descriptors);
        let body = broker_body(&lease, &descriptors[1], json!({"to": "a"}));
        assert_eq!(
            body,
            json!({"leaseId":"car_1","claimId":"8f8e6a52-41e4-4c42-9d1e-4c9a3a1f1a10",
                   "connectorId":"conn_1","tool":"gmail_send","args":{"to":"a"}})
        );
        assert_eq!(
            broker_result(200, br#"{"ok":true,"result":{"n":1}}"#).unwrap(),
            json!({"n": 1})
        );
        let error = broker_result(
            403,
            br#"{"ok":false,"error":{"code":"tool_not_on_lease","message":"This tool is not available to this run."}}"#,
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("tool_not_on_lease"));
        assert!(broker_result(502, b"<html>").is_err());
        assert!(runtime.report_declined.is_some());
        assert_eq!(
            declined_body(&lease, &descriptors[1]),
            json!({"leaseId":"car_1","claimId":"8f8e6a52-41e4-4c42-9d1e-4c9a3a1f1a10",
                   "connectorId":"conn_1","tool":"gmail_send","args":{},"declinedByOwner":true})
        );
    }

    #[test]
    fn only_owner_private_leases_offer_the_connect_link() {
        let mut private = lease(None);
        private.connector_audience = Some("owner_private".into());
        assert!(lease_is_owner_private(&private));
        let mut shared = lease(None);
        shared.connector_audience = Some("shared".into());
        assert!(!lease_is_owner_private(&shared));
        assert!(!lease_is_owner_private(&lease(None)));
        assert!(build(&shared).is_none());
        let local = owner_local();
        assert!(local.descriptors.is_empty() && local.offer_request_connect);
        assert_eq!(
            local
                .tools()
                .iter()
                .map(|tool| tool.name().to_string())
                .collect::<Vec<_>>(),
            ["connectors_request_connect"]
        );
    }

    #[tokio::test]
    async fn a_decline_falls_back_to_the_account_route_when_the_lease_lapsed() {
        let lease = lease(None);
        let tool: ConnectorToolDescriptor = serde_json::from_value(json!(
            {"connectorId":"conn_1","provider":"gmail","name":"gmail_send","group":"act",
             "description":"Send an email."}
        ))
        .unwrap();
        for (broker_code, expected) in [
            ("declined_by_owner", vec![BROKER_CALL_PATH]),
            (
                "lease_invalid",
                vec![
                    BROKER_CALL_PATH,
                    "/v1/cloud/connectors/conn_1/audit/declined",
                ],
            ),
        ] {
            let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
            let sink = seen.clone();
            let post: PostFn = Arc::new(move |path: String, body: Value| {
                sink.lock().unwrap().push((path.clone(), body));
                Box::pin(async move {
                    if path == BROKER_CALL_PATH {
                        Err(KordiError::Tool(format!("Refused. ({broker_code})")))
                    } else {
                        Ok(json!({ "recorded": true }))
                    }
                }) as ConnectorCallFuture
            });
            report_declined(post, lease.clone(), tool.clone()).await;
            let seen = seen.lock().unwrap().clone();
            let paths = seen
                .iter()
                .map(|(path, _)| path.as_str())
                .collect::<Vec<_>>();
            assert_eq!(paths, expected, "{broker_code}");
            assert_eq!(seen[0].1["declinedByOwner"], true);
            if let Some((_, body)) = seen.get(1) {
                assert_eq!(
                    body,
                    &json!({"tool":"gmail_send","summary":"Send an email.","runId":"car_1"})
                );
            }
        }
        assert!(declined_audit_path("conn/../x").is_none());
    }
}

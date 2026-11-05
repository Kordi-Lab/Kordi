//! Complete the hosted test before its passing report can be persisted.
use crate::cloud_session_organization::CloudBearerAuth;
use kordi_cli::desktop_runtime::DesktopCloudExecutionLease;

const LEASE_LOST: &str =
    "The Factory test could not confirm its execution lease. Try the test again.";

pub(super) async fn complete(lease: &DesktopCloudExecutionLease) -> Result<(), String> {
    let session = crate::cloud_session::cloud_session_load()?
        .filter(|session| session.account_id == lease.owner_account_id && !session.token.is_empty())
        .ok_or(LEASE_LOST)?;
    let base = crate::cloud_api_base_url_from_env()?;
    complete_at(&base, &session.token, lease).await
}

async fn complete_at(
    base: &str,
    token: &str,
    lease: &DesktopCloudExecutionLease,
) -> Result<(), String> {
    let mut endpoint = reqwest::Url::parse(base).map_err(|_| LEASE_LOST)?;
    endpoint
        .path_segments_mut()
        .map_err(|_| LEASE_LOST)?
        .extend([
            "v1",
            "cloud",
            "agent-runs",
            "desktop",
            &lease.run_id,
            "complete",
        ]);
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| LEASE_LOST)?
        .post(endpoint)
        .cloud_bearer_auth(token)
        .json(&serde_json::json!({"claimId": lease.claim_id}))
        .send()
        .await
        .map_err(|_| LEASE_LOST)?;
    if !response.status().is_success() {
        return Err(LEASE_LOST.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[tokio::test]
    async fn a_hosted_test_cannot_pass_when_completion_rejects_its_lease() {
        for status in ["200 OK", "409 Conflict"] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0; 4096];
                let length = stream.read(&mut request).unwrap();
                let request = String::from_utf8_lossy(&request[..length]);
                assert!(request
                    .starts_with("POST /v1/cloud/agent-runs/desktop/factory_synthetic/complete "));
                write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
                )
                .unwrap();
            });
            let lease = serde_json::from_value(serde_json::json!({
                "sessionId":"factory:synthetic-owner", "runId":"factory_synthetic",
                "claimId":"synthetic-claim", "ownerAccountId":"synthetic-owner",
            }))
            .unwrap();
            let result = complete_at(&base, "synthetic-token", &lease).await;
            assert_eq!(result.is_ok(), status == "200 OK");
            server.join().unwrap();
        }
    }
}

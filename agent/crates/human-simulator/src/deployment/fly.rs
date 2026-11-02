use super::{Operation, contains, summary};
use crate::{
    client::required_env,
    deployment_config::{Backend, DeploymentConfig},
};
use anyhow::{Context, Result, bail, ensure};
use reqwest::{Client, Method, StatusCode};
use serde_json::{Value, json};
use std::time::Duration;

#[cfg(test)]
#[path = "fly_tests.rs"]
mod tests;

struct Api {
    client: Client,
    base: String,
    token: String,
}
impl Api {
    fn new(app: &str) -> Result<Self> {
        Ok(Self {
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(45))
                .build()?,
            base: format!("https://api.machines.dev/v1/apps/{app}"),
            token: required_env("KORDI_SIM_FLY_TOKEN")?,
        })
    }
    async fn call(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        nonce: Option<&str>,
    ) -> Result<Value> {
        let mut req = self
            .client
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(&self.token);
        if let Some(body) = body {
            req = req.json(&body);
        }
        if let Some(nonce) = nonce {
            req = req.header("fly-machine-lease-nonce", nonce);
        }
        let mut response = req.send().await.map_err(|_| {
            anyhow::anyhow!("Fly request interrupted; inspect worker-status before retrying")
        })?;
        let status = response.status();
        ensure!(
            status.is_success(),
            "Fly API returned HTTP {}; inspect worker-status before retrying",
            status.as_u16()
        );
        if status == StatusCode::NO_CONTENT {
            return Ok(Value::Null);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| anyhow::anyhow!("Fly response interrupted"))?
        {
            ensure!(
                bytes.len() + chunk.len() <= 2 * 1024 * 1024,
                "Fly response exceeds limit"
            );
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("Invalid Fly API response"))
    }
    async fn find(&self, config: &DeploymentConfig) -> Result<Option<Value>> {
        let value = self.call(Method::GET, "/machines", None, None).await?;
        let rows = value.as_array().context("Invalid Fly machine list")?;
        let matches: Vec<_> = rows
            .iter()
            .filter(|row| row["name"] == config.identity())
            .collect();
        ensure!(
            matches.len() <= 1,
            "Multiple matching workers; refusing an ambiguous operation"
        );
        let Some(row) = matches.first() else {
            return Ok(None);
        };
        let id = identifier(row, "id")?;
        let machine = self
            .call(Method::GET, &format!("/machines/{id}"), None, None)
            .await?;
        verify(config, &machine)?;
        Ok(Some(machine))
    }
}

fn identifier(value: &Value, key: &str) -> Result<String> {
    let id = value[key]
        .as_str()
        .context("Missing Fly resource identifier")?;
    ensure!(
        !id.is_empty()
            && id.len() <= 128
            && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'),
        "Invalid Fly resource identifier"
    );
    Ok(id.into())
}
fn empty(value: &Value) -> bool {
    value.is_null()
        || value.as_array().is_some_and(Vec::is_empty)
        || value.as_object().is_some_and(serde_json::Map::is_empty)
}
fn verify(config: &DeploymentConfig, machine: &Value) -> Result<()> {
    let expected = config.manifest();
    let mut actual_config = machine["config"].clone();
    if actual_config.get("auto_destroy").is_none() {
        actual_config["auto_destroy"] = json!(false);
    }
    // Fly may omit an empty services list when returning a created Machine.
    // Normalize only the provider's absent/null representation; a non-empty
    // list must remain visible to the ownership/configuration comparison.
    if expected["config"]["services"] == json!([])
        && (actual_config.get("services").is_none() || actual_config["services"].is_null())
    {
        actual_config["services"] = json!([]);
    }
    ensure!(
        machine["name"] == expected["name"]
            && machine["region"] == expected["region"]
            && contains(&actual_config, &expected["config"]),
        "Existing Fly worker does not match this deployment; no changes made"
    );
    // Do not accept extra command, file, mount, or secret sources on a matched worker.
    for key in [
        "env", "files", "mounts", "init", "secrets", "standbys", "schedule", "checks",
    ] {
        ensure!(
            empty(&machine["config"][key]),
            "Existing Fly worker has unexpected configuration"
        );
    }
    let process = &machine["config"]["processes"][0];
    for key in ["env_from", "exec"] {
        ensure!(
            empty(&process[key]),
            "Existing Fly worker has unexpected process configuration"
        );
    }
    ensure!(
        process["env"] == expected["config"]["processes"][0]["env"],
        "Existing Fly worker has unexpected environment"
    );
    Ok(())
}
fn state(machine: &Value) -> &str {
    match machine["state"].as_str() {
        Some("started") => "running",
        Some("stopped" | "suspended") => "stopped",
        Some("created") => "created",
        Some("starting" | "stopping" | "replacing") => "transitioning",
        Some("failed") => "failed",
        _ => "unknown",
    }
}

pub(super) async fn execute(config: &DeploymentConfig, operation: Operation) -> Result<Value> {
    let Backend::Fly { app, .. } = &config.backend else {
        bail!("Expected Fly deployment")
    };
    execute_with(&Api::new(app)?, config, operation).await
}
async fn execute_with(api: &Api, config: &DeploymentConfig, operation: Operation) -> Result<Value> {
    let existing = api.find(config).await?;
    if matches!(operation, Operation::Status) {
        return Ok(summary("fly", existing.as_ref().map_or("absent", state)));
    }
    if matches!(operation, Operation::Stop) && existing.is_none() {
        return Ok(summary("fly", "absent"));
    }
    let machine = if let Some(machine) = existing {
        machine
    } else {
        let mut body = config.manifest();
        body["skip_launch"] = json!(true);
        // A create is never retried blindly. Its deterministic name permits a
        // later invocation to reconcile an accepted-but-unacknowledged request.
        api.call(Method::POST, "/machines", Some(body), None)
            .await?;
        api.find(config)
            .await?
            .context("Fly creation is not yet visible; inspect worker-status")?
    };
    if (matches!(operation, Operation::Deploy) && state(&machine) == "running")
        || (matches!(operation, Operation::Stop)
            && matches!(state(&machine), "stopped" | "created"))
    {
        return Ok(summary("fly", state(&machine)));
    }
    let id = identifier(&machine, "id")?;
    let lease = api
        .call(
            Method::POST,
            &format!("/machines/{id}/lease"),
            // Covers the lease response and all bounded mutation/wait/release requests.
            Some(json!({"ttl":300})),
            None,
        )
        .await?;
    let nonce = lease["data"]["nonce"]
        .as_str()
        .filter(|s| !s.is_empty())
        .context("Fly lease response has no nonce")?;
    let result = mutate(api, config, operation, &id, nonce).await;
    let released = api
        .call(
            Method::DELETE,
            &format!("/machines/{id}/lease"),
            None,
            Some(nonce),
        )
        .await;
    let result = result?;
    released?;
    Ok(result)
}
async fn mutate(
    api: &Api,
    config: &DeploymentConfig,
    operation: Operation,
    id: &str,
    nonce: &str,
) -> Result<Value> {
    let machine = api
        .call(Method::GET, &format!("/machines/{id}"), None, None)
        .await?;
    verify(config, &machine)?;
    let path = format!("/machines/{id}");
    if matches!(operation, Operation::Stop) {
        if matches!(state(&machine), "stopped" | "created") {
            return Ok(summary("fly", state(&machine)));
        }
        let instance = identifier(&machine, "instance_id")?;
        api.call(
            Method::POST,
            &format!("{path}/stop"),
            Some(json!({"signal":"SIGTERM","timeout":"30s"})),
            Some(nonce),
        )
        .await?;
        api.call(
            Method::GET,
            &format!("{path}/wait?state=stopped&instance_id={instance}&timeout=35"),
            None,
            None,
        )
        .await?;
    } else {
        ensure!(
            matches!(state(&machine), "created" | "stopped" | "running"),
            "Fly worker is transitioning; inspect worker-status before retrying"
        );
        if state(&machine) != "running" {
            api.call(
                Method::POST,
                &format!("{path}/start"),
                Some(json!({})),
                Some(nonce),
            )
            .await?;
            if let Err(wait_error) = api
                .call(
                    Method::GET,
                    &format!("{path}/wait?state=started&timeout=35"),
                    None,
                    None,
                )
                .await
            {
                // A short-lived worker can finish before the started wait observes it.
                // Only an owned, verified stopped machine resolves that ambiguity.
                if let Ok(current) = api.call(Method::GET, &path, None, None).await
                    && identifier(&current, "id").is_ok_and(|current_id| current_id == id)
                    && verify(config, &current).is_ok()
                    && current["state"] == "stopped"
                {
                    return Ok(summary("fly", "stopped"));
                }
                return Err(wait_error);
            }
        }
    }
    let current = api.call(Method::GET, &path, None, None).await?;
    verify(config, &current)?;
    ensure!(
        !matches!(operation, Operation::Stop) || state(&current) == "stopped",
        "Fly worker has not stopped; inspect worker-status"
    );
    Ok(summary("fly", state(&current)))
}

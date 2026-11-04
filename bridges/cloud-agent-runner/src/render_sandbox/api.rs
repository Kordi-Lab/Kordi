use super::{error, RenderSandboxConfig, CHECKPOINT_LIMIT};
use crate::sandbox_client::SandboxClientError;
use reqwest::{Client, Method, Response, Url};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

#[derive(Clone)]
pub(super) struct Api {
    client: Client,
    token: String,
    owner: String,
    group: String,
    active: Arc<Mutex<HashSet<String>>>,
    ambiguous_create: Arc<AtomicBool>,
}
impl Api {
    pub fn new(config: &RenderSandboxConfig) -> Result<Self, SandboxClientError> {
        Ok(Self {
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(50))
                .build()
                .map_err(|_| error("Invalid HTTP client"))?,
            token: config.token.clone(),
            owner: config.owner.clone(),
            group: config.group.clone(),
            active: Arc::new(Mutex::new(HashSet::new())),
            ambiguous_create: Arc::new(AtomicBool::new(false)),
        })
    }
    async fn json_response(response: Response, limit: usize) -> Result<Value, SandboxClientError> {
        let data = Self::bounded(response, limit).await?;
        serde_json::from_slice(&data).map_err(|_| error("Invalid Render response"))
    }
    async fn bounded(mut response: Response, limit: usize) -> Result<Vec<u8>, SandboxClientError> {
        if !response.status().is_success() {
            return Err(error("Render request failed"));
        }
        let mut data = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| error("Render response interrupted"))?
        {
            if chunk.len() > limit.saturating_sub(data.len()) {
                return Err(error("Render response exceeds limit"));
            }
            data.extend_from_slice(&chunk);
        }
        Ok(data)
    }
    pub(super) async fn call(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, SandboxClientError> {
        let mut request = self
            .client
            .request(method, format!("https://api.render.com/v1{path}"))
            .query(&[("ownerId", &self.owner)])
            .bearer_auth(&self.token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .await
            .map_err(|_| error("Render control request failed"))?;
        if response.status() == reqwest::StatusCode::NO_CONTENT {
            return Ok(Value::Null);
        }
        Self::json_response(response, 2 * 1024 * 1024).await
    }
    pub async fn create(&self) -> Result<Guest, SandboxClientError> {
        let group = self
            .call(
                Method::GET,
                &format!("/sandbox-groups/{}", self.group),
                None,
            )
            .await?;
        if group["ownerId"] != self.owner
            || group["region"] != "oregon"
            || !group["concurrencyLimit"]
                .as_u64()
                .is_some_and(|limit| (1..=4).contains(&limit))
        {
            return Err(error("Render sandbox group must have the selected owner, Oregon region, and at most four active guests"));
        }
        // An ambiguous POST is never retried. The remote hard deadline bounds an
        // orphan if the response is lost before its ID can be recorded.
        if self.ambiguous_create.swap(true, Ordering::SeqCst) {
            return Err(error(
                "An earlier Render create is unresolved; refusing to retry",
            ));
        }
        let value = self
            .call(
                Method::POST,
                "/sandboxes",
                Some(json!({
                    "ownerId": self.owner, "sandboxGroupId": self.group, "plan": "1c-2g",
                    "timeoutSeconds": 300, "idleTimeoutSeconds": 300,
                    "networkPolicy": {"type": "deny-all"}, "env": {}
                })),
            )
            .await?;
        let id = value["id"]
            .as_str()
            .filter(|id| super::identifier(id, "sbx-"))
            .ok_or_else(|| error("Invalid Render sandbox identity"))?
            .to_owned();
        self.active
            .lock()
            .map_err(|_| error("Render lifecycle lock failed"))?
            .insert(id.clone());
        self.ambiguous_create.store(false, Ordering::SeqCst);
        let guest = Guest {
            api: self.clone(),
            id,
            terminated: false,
        };
        if value["sandboxGroupId"] != self.group || value["networkPolicy"]["type"] != "deny-all" {
            return Err(error("Render sandbox isolation mismatch"));
        }
        tokio::time::timeout(Duration::from_secs(60), async {
            loop {
                let value = self
                    .call(Method::GET, &format!("/sandboxes/{}", guest.id), None)
                    .await?;
                match value["status"].as_str() {
                    Some("running") => return Ok(()),
                    Some("creating") => tokio::time::sleep(Duration::from_secs(1)).await,
                    _ => return Err(error("Render sandbox did not start")),
                }
            }
        })
        .await
        .map_err(|_| error("Render sandbox startup timed out"))??;
        Ok(guest)
    }
    pub async fn drain_cleanup(&self) -> Result<(), SandboxClientError> {
        let pending: Vec<String> = self
            .active
            .lock()
            .map_err(|_| error("Render lifecycle lock failed"))?
            .iter()
            .cloned()
            .collect();
        let mut failed = false;
        for id in pending {
            if self.terminate(&id).await.is_err() {
                failed = true;
            }
        }
        if failed || self.ambiguous_create.load(Ordering::SeqCst) {
            return Err(error(
                "Render guest termination could not be confirmed; remote lifetime remains bounded",
            ));
        }
        Ok(())
    }
    async fn connect(
        &self,
        id: &str,
        path: &str,
        method: &str,
    ) -> Result<(Url, String), SandboxClientError> {
        let value = self
            .call(
                Method::POST,
                &format!("/sandboxes/{id}/{path}"),
                Some(json!({})),
            )
            .await?;
        let uri = value["uri"]
            .as_str()
            .ok_or_else(|| error("Missing Render capability URI"))?;
        let url = validate_capability(uri, id, method, &value)?;
        let token = value["token"]
            .as_str()
            .filter(|t| !t.is_empty())
            .ok_or_else(|| error("Missing Render capability"))?;
        Ok((url, token.into()))
    }
    pub async fn exec(&self, id: &str, command: String) -> Result<Value, SandboxClientError> {
        // Do not put command contents in the control-plane execution timeline.
        let (url, token) = self.connect(id, "runs/sync/token", "POST").await?;
        let response = self
            .client
            .post(url)
            .bearer_auth(token)
            .json(&json!({"command": command}))
            .send()
            .await
            .map_err(|_| error("Render execution failed"))?;
        let value = Self::json_response(response, 4 * 1024 * 1024).await?;
        if value["exit_code"] != 0 {
            return Err(error("Render guest executor failed"));
        }
        serde_json::from_str(
            value["stdout"]
                .as_str()
                .ok_or_else(|| error("Missing Render output"))?,
        )
        .map_err(|_| error("Invalid Render operation output"))
    }
    pub async fn upload(&self, id: &str, bytes: Vec<u8>) -> Result<(), SandboxClientError> {
        let (url, token) = self
            .connect(
                id,
                "files/upload/token?path=%2Ftmp%2Fkordi-checkpoint.json",
                "PUT",
            )
            .await?;
        let response = self
            .client
            .put(url)
            .bearer_auth(token)
            .header("Content-Type", "application/octet-stream")
            .body(bytes)
            .send()
            .await
            .map_err(|_| error("Render workspace restore failed"))?;
        Self::bounded(response, 1024).await?;
        Ok(())
    }
    pub async fn download(&self, id: &str) -> Result<Vec<u8>, SandboxClientError> {
        let (url, token) = self
            .connect(
                id,
                "files/download/token?path=%2Ftmp%2Fkordi-checkpoint.json",
                "GET",
            )
            .await?;
        let response = self
            .client
            .get(url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|_| error("Render checkpoint download failed"))?;
        Self::bounded(response, CHECKPOINT_LIMIT).await
    }
    async fn terminate(&self, id: &str) -> Result<(), SandboxClientError> {
        tokio::time::timeout(Duration::from_secs(60), async {
            self.call(Method::POST, &format!("/sandboxes/{id}/terminate"), None)
                .await?;
            loop {
                let state = self
                    .call(Method::GET, &format!("/sandboxes/{id}"), None)
                    .await?;
                if state["status"] == "terminated" {
                    return Ok::<(), SandboxClientError>(());
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        })
        .await
        .map_err(|_| error("Render termination timed out"))??;
        self.active
            .lock()
            .map_err(|_| error("Render lifecycle lock failed"))?
            .remove(id);
        Ok(())
    }
}
pub(super) fn validate_capability(
    uri: &str,
    id: &str,
    method: &str,
    value: &Value,
) -> Result<Url, SandboxClientError> {
    let url = Url::parse(uri).map_err(|_| error("Invalid Render capability URI"))?;
    let host = format!("{id}.oregon.sandbox.onrender.com");
    if url.scheme() != "https"
        || url.host_str() != Some(&host)
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || value["method"] != method
    {
        return Err(error("Untrusted Render capability endpoint"));
    }
    Ok(url)
}
pub(super) struct Guest {
    api: Api,
    pub id: String,
    terminated: bool,
}
impl Guest {
    pub async fn finish(&mut self) -> Result<(), SandboxClientError> {
        self.api.terminate(&self.id).await?;
        self.terminated = true;
        Ok(())
    }
}
impl Drop for Guest {
    fn drop(&mut self) {
        if !self.terminated {
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                let api = self.api.clone();
                let id = self.id.clone();
                runtime.spawn(async move {
                    let _ = api.terminate(&id).await;
                });
            }
        }
    }
}

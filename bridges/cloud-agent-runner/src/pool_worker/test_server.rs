//! A small loopback HTTP server that records requests and answers each one
//! from a handler. One request per connection.

use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Debug, Clone)]
pub(crate) struct Recorded {
    pub method: String,
    /// Path with query string.
    pub path: String,
    /// Lowercased header block.
    pub head: String,
    pub body: Value,
}

impl Recorded {
    pub fn header(&self, name: &str) -> Option<String> {
        let prefix = format!("{}:", name.to_ascii_lowercase());
        self.head
            .lines()
            .find_map(|line| line.strip_prefix(&prefix))
            .map(|value| value.trim().to_string())
    }
}

type Handler = dyn Fn(&Recorded) -> (u16, String) + Send + Sync;

pub(crate) struct MockServer {
    pub url: String,
    pub requests: Arc<Mutex<Vec<Recorded>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl MockServer {
    pub async fn start(
        handler: impl Fn(&Recorded) -> (u16, String) + Send + Sync + 'static,
    ) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let handler: Arc<Handler> = Arc::new(handler);
        let log = Arc::clone(&requests);
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let handler = Arc::clone(&handler);
                let log = Arc::clone(&log);
                tokio::spawn(async move {
                    let Some(request) = read_request(&mut stream).await else {
                        return;
                    };
                    let (status, body) = handler(&request);
                    log.lock().unwrap().push(request);
                    let response = format!(
                        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });
        Self {
            url,
            requests,
            task,
        }
    }

    pub fn recorded(&self) -> Vec<Recorded> {
        self.requests.lock().unwrap().clone()
    }

    pub fn paths(&self) -> Vec<String> {
        self.recorded().into_iter().map(|r| r.path).collect()
    }
}

async fn read_request(stream: &mut tokio::net::TcpStream) -> Option<Recorded> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        let read = stream.read(&mut buffer).await.ok()?;
        if read == 0 {
            return None;
        }
        bytes.extend_from_slice(&buffer[..read]);
        let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") else {
            continue;
        };
        let head = String::from_utf8_lossy(&bytes[..end]).to_string();
        let lower = head.to_ascii_lowercase();
        let length: usize = lower
            .lines()
            .find_map(|line| line.strip_prefix("content-length:"))
            .and_then(|value| value.trim().parse().ok())
            .unwrap_or(0);
        if bytes.len() < end + 4 + length {
            continue;
        }
        let mut request_line = head.lines().next()?.split_whitespace();
        let method = request_line.next()?.to_string();
        let path = request_line.next()?.to_string();
        let raw = &bytes[end + 4..end + 4 + length];
        let body = if raw.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(raw).unwrap_or(Value::Null)
        };
        return Some(Recorded {
            method,
            path,
            head: lower,
            body,
        });
    }
}

/// A unique scratch file path under the system temp directory.
pub(crate) fn temp_file(contents: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!(
        "kordi-pool-worker-test-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::write(&path, contents).unwrap();
    path
}

/// A config from `KORDI_POOL_WORKER_*` suffixes, with Google endpoints on `google`.
pub(crate) fn config(values: &[(&str, &str)], google: &str) -> super::PoolWorkerConfig {
    let mut config = super::PoolWorkerConfig::from_lookup(|name| {
        let short = name.strip_prefix("KORDI_POOL_WORKER_")?;
        values
            .iter()
            .find(|(key, _)| *key == short)
            .map(|(_, value)| value.to_string())
    })
    .unwrap();
    config.metadata_url = google.to_string();
    config.secret_manager_url = google.to_string();
    config
}

/// An unsigned JWT-shaped token that expires `seconds` from now.
pub(crate) fn fake_jwt(seconds: i64) -> String {
    use base64::Engine;
    let encode = |value: serde_json::Value| {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.to_string())
    };
    let exp = chrono::Utc::now().timestamp() + seconds;
    format!(
        "{}.{}.{}",
        encode(serde_json::json!({"alg": "none"})),
        encode(serde_json::json!({"aud": "synthetic", "exp": exp})),
        "unsigned"
    )
}

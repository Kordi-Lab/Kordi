use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
type WsWriter = SplitSink<WsStream, Message>;
type WsReader = SplitStream<WsStream>;

#[derive(Debug, Serialize, Deserialize)]
struct DerpFrame {
    src: Option<String>,
    dst: Option<String>,
    #[serde(with = "base64_serde")]
    data: Vec<u8>,
}

mod base64_serde {
    use base64::Engine;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(data: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&base64::engine::general_purpose::STANDARD.encode(data))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        base64::engine::general_purpose::STANDARD
            .decode(&s)
            .map_err(serde::de::Error::custom)
    }
}

/// WebSocket client for DERP relay coordination server.
pub struct DerpClient {
    write: Mutex<WsWriter>,
    read: Mutex<WsReader>,
    url: String,
    api_key: String,
}

impl DerpClient {
    /// Connect to a DERP relay server via WebSocket.
    pub async fn connect(url: &str, api_key: &str) -> Result<Self, String> {
        let url = normalize_ws_url(url)?;
        let request = build_ws_request(&url, api_key)?;
        let (ws, _resp) = connect_async(request)
            .await
            .map_err(|e| format!("DERP connect: {}", e))?;
        let (write, read) = ws.split();
        Ok(Self {
            write: Mutex::new(write),
            read: Mutex::new(read),
            url,
            api_key: api_key.to_string(),
        })
    }

    /// Send encrypted data to a destination node through the relay.
    pub async fn send(&self, dst_node_id: &str, encrypted_blob: &[u8]) -> Result<(), String> {
        let frame = DerpFrame {
            src: None,
            dst: Some(dst_node_id.to_string()),
            data: encrypted_blob.to_vec(),
        };
        let json = serde_json::to_string(&frame).map_err(|e| format!("serialize: {}", e))?;
        self.write
            .lock()
            .await
            .send(Message::Text(json))
            .await
            .map_err(|e| format!("DERP send: {}", e))
    }

    /// Receive the next message from the relay. Returns (src_node_id, encrypted_blob).
    pub async fn recv(&self) -> Result<(String, Vec<u8>), String> {
        loop {
            let msg = {
                let mut read = self.read.lock().await;
                read.next().await
            };
            match msg {
                Some(Ok(Message::Text(text))) => {
                    let frame: DerpFrame = serde_json::from_str(&text)
                        .map_err(|e| format!("parse DERP frame: {}", e))?;
                    let src = frame.src.unwrap_or_default();
                    return Ok((src, frame.data));
                }
                Some(Ok(Message::Ping(data))) => {
                    self.write
                        .lock()
                        .await
                        .send(Message::Pong(data))
                        .await
                        .map_err(|e| format!("pong: {}", e))?;
                }
                Some(Ok(Message::Close(_))) | None => {
                    self.reconnect().await?;
                    continue;
                }
                Some(Ok(_)) => continue,
                Some(Err(e)) => {
                    return Err(format!("DERP recv error: {}", e));
                }
            }
        }
    }

    /// Reconnect after disconnect.
    async fn reconnect(&self) -> Result<(), String> {
        let request = build_ws_request(&self.url, &self.api_key)?;
        let (ws, _) = connect_async(request)
            .await
            .map_err(|e| format!("DERP reconnect: {}", e))?;
        let (write, read) = ws.split();
        *self.write.lock().await = write;
        *self.read.lock().await = read;
        Ok(())
    }
}

fn normalize_ws_url(url: &str) -> Result<String, String> {
    if let Some(rest) = url.strip_prefix("http://") {
        return Ok(format!("ws://{}", rest));
    }
    if let Some(rest) = url.strip_prefix("https://") {
        return Ok(format!("wss://{}", rest));
    }
    if url.starts_with("ws://") || url.starts_with("wss://") {
        return Ok(url.to_string());
    }
    Err(format!(
        "DERP URL must start with http(s):// or ws(s)://: {}",
        url
    ))
}

fn build_ws_request(
    url: &str,
    api_key: &str,
) -> Result<tokio_tungstenite::tungstenite::http::Request<()>, String> {
    use tokio_tungstenite::tungstenite::http::{self, Uri};

    let uri: Uri = url
        .parse()
        .map_err(|e| format!("DERP parse URL {}: {}", url, e))?;
    let host = uri
        .authority()
        .map(|authority| authority.as_str().to_string())
        .ok_or_else(|| format!("DERP URL missing host: {}", url))?;

    http::Request::builder()
        .uri(uri)
        .header("Host", host)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header(
            "Sec-WebSocket-Key",
            tokio_tungstenite::tungstenite::handshake::client::generate_key(),
        )
        .body(())
        .map_err(|e| format!("DERP request: {}", e))
}

#[cfg(test)]
mod tests {
    use super::{build_ws_request, normalize_ws_url};

    #[test]
    fn normalize_http_urls_for_websocket() {
        assert_eq!(
            normalize_ws_url("http://127.0.0.1:17080/ws/derp").unwrap(),
            "ws://127.0.0.1:17080/ws/derp"
        );
        assert_eq!(
            normalize_ws_url("https://example.com/ws/derp").unwrap(),
            "wss://example.com/ws/derp"
        );
    }

    #[test]
    fn websocket_request_includes_host_header() {
        let request = build_ws_request("ws://127.0.0.1:17080/ws/derp", "bridges_sk_test").unwrap();
        assert_eq!(
            request.headers().get("host").and_then(|v| v.to_str().ok()),
            Some("127.0.0.1:17080")
        );
        assert_eq!(
            request
                .headers()
                .get("authorization")
                .and_then(|v| v.to_str().ok()),
            Some("Bearer bridges_sk_test")
        );
    }
}

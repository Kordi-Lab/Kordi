use super::*;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

async fn server(
    responses: Vec<(&'static str, String)>,
) -> (String, tokio::task::JoinHandle<usize>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1/systemone", listener.local_addr().unwrap());
    let handle = tokio::spawn(async move {
        let mut count = 0;
        for (status, body) in responses {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                let n = socket.read(&mut buffer).await.unwrap();
                if n == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..n]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                    let size: usize = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length: "))
                        .unwrap()
                        .parse()
                        .unwrap();
                    if bytes.len() >= end + 4 + size {
                        let input: Value =
                            serde_json::from_slice(&bytes[end + 4..end + 4 + size]).unwrap();
                        assert_eq!(input["model"], "test");
                        assert_eq!(input["questions"]["material"]["type"], "noul");
                        break;
                    }
                }
            }
            count += 1;
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        }
        count
    });
    (url, handle)
}
fn request() -> EvaluationRequest {
    EvaluationRequest {
        state: serde_json::json!({"text":"synthetic"}),
        questions: BTreeMap::from([(
            "material".into(),
            Question::Noul {
                instructions: "Material change?".into(),
            },
        )]),
    }
}
fn response() -> String {
    serde_json::json!({"model":"test","usage":{"input_tokens":5,"output_tokens":0},"answers":{"material":{"type":"noul","noul":0.1}}}).to_string()
}
#[tokio::test]
async fn retries_transient_failure_once_then_validates_response() {
    let (url, handle) = server(vec![
        ("429 Too Many Requests", "secret upstream error".into()),
        ("200 OK", response()),
    ])
    .await;
    let provider = JevProvider::with_endpoint("fixture".into(), "test".into(), &url).unwrap();
    assert!(provider.evaluate(&request()).await.is_ok());
    assert_eq!(handle.await.unwrap(), 2);
}
#[tokio::test]
async fn failures_are_redacted_and_not_retried_for_auth() {
    let (url, handle) = server(vec![(
        "401 Unauthorized",
        "secret credential details".into(),
    )])
    .await;
    let provider = JevProvider::with_endpoint("fixture".into(), "test".into(), &url).unwrap();
    let error = provider.evaluate(&request()).await.unwrap_err();
    assert_eq!(error.to_string(), "evaluation HTTP status 401");
    assert_eq!(handle.await.unwrap(), 1);
}
#[tokio::test]
async fn malformed_and_oversized_responses_are_rejected() {
    for body in ["not json".to_string(), "x".repeat(65_000)] {
        let (url, handle) = server(vec![("200 OK", body)]).await;
        let provider = JevProvider::with_endpoint("fixture".into(), "test".into(), &url).unwrap();
        assert_eq!(
            provider.evaluate(&request()).await.unwrap_err(),
            EvaluationError::Invalid
        );
        handle.await.unwrap();
    }
}

#[tokio::test]
async fn persistent_overload_stops_after_one_retry() {
    let (url, handle) = server(vec![
        ("529 Overloaded", "busy".into()),
        ("529 Overloaded", "busy".into()),
    ])
    .await;
    let provider = JevProvider::with_endpoint("fixture".into(), "test".into(), &url).unwrap();
    assert_eq!(
        provider.evaluate(&request()).await.unwrap_err(),
        EvaluationError::Http(529)
    );
    assert_eq!(handle.await.unwrap(), 2);
}

#[test]
fn gateway_contract_maps_boolean_usage_and_absent_confidence() {
    let request = EvaluationRequest {
        state: serde_json::json!({}),
        questions: BTreeMap::from([
            (
                "route".into(),
                Question::Choice {
                    instructions: "Choose".into(),
                    criteria: BTreeMap::from([
                        ("skip".into(), "irrelevant".into()),
                        ("generate".into(), "material".into()),
                    ]),
                },
            ),
            (
                "material".into(),
                Question::Noul {
                    instructions: "Material?".into(),
                },
            ),
            (
                "priority".into(),
                Question::Score {
                    instructions: "Priority?".into(),
                    criteria: vec!["low".into(), "high".into()],
                },
            ),
        ]),
    };
    let raw = serde_json::json!({"answers":{
        "route":{"type":"choice","choice":"skip","probabilities":{"skip":0.999,"generate":0.001}},
        "material":{"type":"boolean","probability":0.1},
        "priority":{"type":"score","score":0.8,"probabilities":{"0":0.2,"1":0.8}}
    },"usage":{"inputTokens":15,"outputTokens":3},"warnings":[]});
    let mapped = gateway_response(
        &serde_json::to_vec(&raw).unwrap(),
        &request,
        "typesafe-ai/jev",
    )
    .unwrap();
    mapped.validate(&request).unwrap();
    assert!(matches!(
        mapped.answers["route"],
        Answer::Choice {
            confidence: None,
            ..
        }
    ));
    assert_eq!(mapped.usage.input_tokens, 15);
    assert_eq!(mapped.choice("route", 0.98), Some("skip"));
    let mut uncertain = raw.clone();
    uncertain["answers"]["route"]["probabilities"] =
        serde_json::json!({"skip":0.99,"generate":0.01});
    let mapped = gateway_response(
        &serde_json::to_vec(&uncertain).unwrap(),
        &request,
        "typesafe-ai/jev",
    )
    .unwrap();
    assert_eq!(mapped.choice("route", 0.98), None);
    let mut missing = raw.clone();
    missing["answers"]["route"]
        .as_object_mut()
        .unwrap()
        .remove("probabilities");
    assert!(gateway_response(
        &serde_json::to_vec(&missing).unwrap(),
        &request,
        "typesafe-ai/jev"
    )
    .is_err());
    let mut warning = raw;
    warning["warnings"] = serde_json::json!([{"type":"unsupported","feature":"choice"}]);
    assert!(gateway_response(
        &serde_json::to_vec(&warning).unwrap(),
        &request,
        "typesafe-ai/jev"
    )
    .is_err());
}

#[tokio::test]
async fn gateway_sends_v4_headers_and_boolean_questions_without_model_in_body() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "http://{}/v4/ai/evaluation-model",
        listener.local_addr().unwrap()
    );
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        let mut buffer = [0; 4096];
        loop {
            let n = socket.read(&mut buffer).await.unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&buffer[..n]);
            if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                let size: usize = headers
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length: "))
                    .unwrap()
                    .parse()
                    .unwrap();
                if bytes.len() >= end + 4 + size {
                    assert!(headers.contains("ai-model-id: typesafe-ai/jev"));
                    assert!(headers.contains("ai-evaluation-model-specification-version: 4"));
                    assert!(headers.contains("ai-gateway-protocol-version: 0.0.1"));
                    assert!(headers.contains("ai-gateway-auth-method: api-key"));
                    let input: Value =
                        serde_json::from_slice(&bytes[end + 4..end + 4 + size]).unwrap();
                    assert!(input.get("model").is_none());
                    assert_eq!(input["questions"]["material"]["type"], "boolean");
                    break;
                }
            }
        }
        let body = r#"{"answers":{"material":{"type":"boolean","probability":0.1}},"usage":{"inputTokens":5},"warnings":[]}"#;
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    });
    let mut provider =
        JevProvider::with_endpoint("fixture".into(), "typesafe-ai/jev".into(), &url).unwrap();
    provider.gateway = true;
    assert!(provider.evaluate(&request()).await.is_ok());
    server.await.unwrap();
}

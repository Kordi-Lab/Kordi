use super::*;

#[test]
fn every_response_state_retains_its_request_thread() {
    let request =
        format!("kordi-cloud-message:{}", URL_SAFE_NO_PAD.encode(serde_json::to_vec(&json!({
        "kind":"message", "text":"Continue", "messageAction":{
            "schemaVersion":1, "kind":"thread", "source":{
                "sourceSessionId":"session:contact", "sourceMessageId":"root", "senderLabel":"Owner"
            }
        }
    })).unwrap()));
    for state in ["processing", "complete", "failed", "cancelled"] {
        let response = format!("kordi-cloud-agent-response:{}", URL_SAFE_NO_PAD.encode(serde_json::to_vec(&json!({
            "kind":"agent-response", "requestId":"request", "text":"Result", "deliveryState":state
        })).unwrap()));
        let merged = response_with_thread_action(&response, &request).unwrap();
        let value: Value = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(merged.strip_prefix("kordi-cloud-agent-response:").unwrap())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(value["messageAction"]["source"]["sourceMessageId"], "root");
        assert_eq!(value["requestId"], "request");
        assert_eq!(value["deliveryState"], state);
    }
}

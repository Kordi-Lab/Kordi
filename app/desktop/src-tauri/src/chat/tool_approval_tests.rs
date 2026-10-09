use super::*;

fn act_tools() -> ActTools {
    HashMap::from([("gmail_send".to_string(), "gmail".to_string())])
}

fn context() -> ApprovalContext {
    ApprovalContext {
        session_id: "session:dm:1".into(),
        conversation_title: Some("Trip planning".into()),
        agent_name: Some("Kordi".into()),
    }
}

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

async fn ask(broker: &ApprovalBroker, emit: &Emit, tool: &str, wait: Duration) -> bool {
    broker
        .request(emit, &act_tools(), &context(), request(tool), wait)
        .await
        .approved()
}

#[tokio::test]
async fn the_person_answers_through_the_respond_command() {
    let broker = Arc::new(ApprovalBroker::default());
    let (emit, events) = responder(broker.clone(), Some(true));
    assert!(ask(&broker, &emit, "gmail_send", Duration::from_secs(5)).await);
    let events = events.lock().unwrap().clone();
    assert_eq!(events[0].0, REQUEST_EVENT);
    let prompt = &events[0].1;
    assert_eq!(prompt["tool"], "gmail_send");
    assert_eq!(prompt["summary"], "Send an email.");
    assert_eq!(prompt["connector"], "gmail");
    assert_eq!(prompt["args"]["to"], "a@example.com");
    assert_eq!(prompt["argsTruncated"], false);
    assert_eq!(prompt["sessionId"], "session:dm:1");
    assert_eq!(prompt["conversationTitle"], "Trip planning");
    assert_eq!(prompt["agentName"], "Kordi");
    assert_eq!(events[1].0, RESOLVED_EVENT);
    assert_eq!(events[1].1["approved"], true);

    let (emit, _) = responder(broker.clone(), Some(false));
    assert!(!ask(&broker, &emit, "gmail_send", Duration::from_secs(5)).await);
    assert!(broker.pending().is_empty());
}

#[tokio::test]
async fn no_answer_in_time_denies_and_late_answers_are_ignored() {
    let broker = Arc::new(ApprovalBroker::default());
    let (emit, events) = responder(broker.clone(), None);
    assert!(!ask(&broker, &emit, "gmail_send", Duration::from_millis(20)).await);
    let id = events.lock().unwrap()[0].1["requestId"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(!broker.respond(&id, true), "the prompt expired");
    assert_eq!(events.lock().unwrap()[1].1["approved"], false);
}

#[tokio::test]
async fn open_prompts_are_listed_until_answered() {
    let broker = Arc::new(ApprovalBroker::default());
    // A webview that was not mounted: the event goes nowhere visible.
    let (emit, _) = responder(broker.clone(), None);
    let waiting = {
        let (broker, emit) = (broker.clone(), emit.clone());
        tokio::spawn(async move { ask(&broker, &emit, "gmail_send", Duration::from_secs(5)).await })
    };
    let mut open = Vec::new();
    for _ in 0..200 {
        open = broker.pending();
        if !open.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(open.len(), 1);
    assert_eq!(open[0].tool, "gmail_send");
    assert_eq!(open[0].context, context());
    // The webview mounts, reads the prompt, and the person allows it.
    assert!(broker.respond(&open[0].request_id, true));
    assert!(waiting.await.unwrap());
    assert!(broker.pending().is_empty());
}

#[tokio::test]
async fn only_act_tools_on_the_lease_are_prompted() {
    let broker = Arc::new(ApprovalBroker::default());
    let (emit, events) = responder(broker.clone(), Some(true));
    for tool in ["bash", "gmail_search"] {
        assert!(
            !ask(&broker, &emit, tool, Duration::from_secs(5)).await,
            "{tool}"
        );
    }
    assert!(hook(ActTools::new(), context()).is_none());
    assert!(events.lock().unwrap().is_empty());
    // A webview that cannot be reached denies at once.
    let unreachable: Emit = Arc::new(|_, _| false);
    assert!(!ask(&broker, &unreachable, "gmail_send", Duration::from_secs(5)).await);
}

#[test]
fn a_lease_descriptor_named_like_a_built_in_never_gets_a_card() {
    let lease: DesktopCloudExecutionLease = serde_json::from_value(json!({
        "sessionId": "session:dm:1", "runId": "car_1", "claimId": "claim_1",
        "ownerAccountId": "acct_1", "connectorAudience": "owner_private",
        "connectorTools": [
            {"connectorId": "conn_1", "provider": "gmail", "name": "bash",
             "group": "act", "description": "Not a shell."},
            {"connectorId": "conn_1", "provider": "gmail", "name": "web_fetch",
             "group": "act", "description": "Not a fetch."},
            {"connectorId": "conn_1", "provider": "gmail", "name": "gmail.send",
             "group": "act", "description": "Bad shape."},
            {"connectorId": "conn_1", "provider": "gmail", "name": "gmail_search",
             "group": "read", "description": "Search mail."},
            {"connectorId": "conn_1", "provider": "gmail", "name": "gmail_send",
             "group": "act", "description": "Send an email."}
        ]
    }))
    .unwrap();
    let act_tools = act_tools_for_lease(Some(&lease));
    assert_eq!(
        act_tools,
        HashMap::from([("gmail_send".to_string(), "gmail".to_string())])
    );
    assert!(act_tools_for_lease(None).is_empty());
}

#[test]
fn large_arguments_are_bounded_and_marked() {
    let small = r#"{"to":["a@example.com"],"subject":"Hi","body":"Short"}"#;
    assert_eq!(
        bounded_args(small),
        (serde_json::from_str(small).unwrap(), false)
    );
    let body = "x".repeat(40_000);
    let large = json!({"to": ["a@example.com", "b@example.com"], "subject": "Hi", "body": body});
    let (args, truncated) = bounded_args(&large.to_string());
    assert!(truncated);
    assert!(serde_json::to_vec(&args).unwrap().len() <= MAX_ARGS_BYTES);
    assert_eq!(args["to"], json!(["a@example.com", "b@example.com"]));
    assert_eq!(args["subject"], "Hi");
    assert!(args["body"].as_str().unwrap().ends_with('…'));
    let (text, truncated) = bounded_args(&"é".repeat(20_000));
    assert!(truncated && text.as_str().unwrap().ends_with('…'));
}

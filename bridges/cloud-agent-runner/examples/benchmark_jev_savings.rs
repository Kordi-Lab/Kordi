//! Paired synthetic comparison through the real consumer loops and simulated tools.
#[path = "savings/providers.rs"]
mod providers;
#[path = "savings/remote.rs"]
mod remote;
use kordi_cloud_agent_runner::{
    client::CloudAgentRun,
    evaluation::{
        routing::{Mode, Router},
        JevProvider,
    },
};
use providers::*;
use serde_json::{json, Value};
use std::{
    sync::{atomic::AtomicUsize, Arc, Mutex},
    time::{Duration, Instant},
};

fn prompt(consumer: &str) -> &'static str {
    let text = if consumer == "pip" {
        include_str!("../../cloud-server/src/pip/prompt.rs")
    } else {
        include_str!("../../cloud-server/src/digest/mod.rs")
    };
    text.split_once("&str = r#\"")
        .unwrap()
        .1
        .split_once("\"#;")
        .unwrap()
        .0
}
fn quality(f: &Fixture, output: &Value, actions: &[Value]) -> bool {
    if f.consumer == "pip" {
        if f.expected == "none" {
            return actions.is_empty() && output["message"].is_null();
        }
        return actions.iter().any(|a| a["action"] == f.expected)
            && (f.expected != "rsvp"
                || (actions
                    .iter()
                    .any(|a| a["rsvp"] == "no" && a["participantId"] == "bob")
                    && !actions.iter().any(|a| a["action"] == "cancel")));
    }
    let items: Vec<_> = ["claims", "commitments", "suggestions", "calendarCandidates"]
        .iter()
        .flat_map(|key| output[*key].as_array().into_iter().flatten())
        .collect();
    if f.expected == "none" {
        return items.is_empty();
    }
    if items.iter().any(|item| {
        item["sourceIds"]
            .as_array()
            .is_none_or(|ids| ids.is_empty() || ids.iter().any(|id| id != "new" && id != "old"))
    }) {
        return false;
    }
    match f.expected.as_str() {
        "commitment" => output["commitments"]
            .as_array()
            .is_some_and(|v| !v.is_empty()),
        "delete" => output["calendarCandidates"].as_array().is_some_and(|v| {
            v.iter().any(|i| {
                i["calendarAction"] == "delete" && i["existingEventId"] == "synthetic-review"
            })
        }),
        _ => !items.is_empty(),
    }
}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    anyhow::ensure!(
        std::env::args().nth(1).as_deref() == Some("--live"),
        "--live is required for synthetic provider calls"
    );
    let suite: Value = serde_json::from_str(include_str!("savings/fixtures.json"))?;
    let fixtures: Vec<Fixture> = serde_json::from_value(suite["cases"].clone())?;
    let evaluator = Arc::new(Evaluator {
        inner: JevProvider::from_env()?,
        records: Mutex::new(Vec::new()),
    });
    let on = Router::new(
        Some(evaluator.clone()),
        "typesafe-ai/jev".into(),
        Mode::Enabled,
        Mode::Enabled,
    );
    let off = Router::new(None, "disabled".into(), Mode::Off, Mode::Off);
    let remote = match std::env::var("KORDI_BENCH_PROVIDER_HELPER") {
        Ok(helper) => Some(Arc::new(remote::Remote::start(&helper).await?)),
        Err(_) => None,
    };
    let (key, model, endpoint, route) = if let Some(remote) = &remote {
        (
            String::new(),
            remote.model.clone(),
            "",
            "development-pip-over-ssh",
        )
    } else {
        match std::env::var("KORDI_PIP_OPENAI_API_KEY") {
            Ok(key) => (
                key,
                std::env::var("KORDI_PIP_OPENAI_MODEL").unwrap_or("gpt-5.6-luna".into()),
                "https://api.openai.com/v1/chat/completions",
                "configured-local-pip",
            ),
            Err(_) => (
                std::env::var("AI_GATEWAY_API_KEY")?,
                "openai/gpt-5.6-luna".into(),
                "https://ai-gateway.vercel.sh/v1/chat/completions",
                "vercel-same-model-proxy",
            ),
        }
    };
    let total_calls = Arc::new(AtomicUsize::new(0));
    let http = client();
    println!(
        "{}",
        json!({"type":"manifest","seed":suite["seed"],"cases":fixtures.len(),"model":model,"generationRoute":route,"settings":{"temperature":0,"reasoning":"none","maxCompletionTokens":2048},"syntheticOnly":true})
    );
    for (index, f) in fixtures.iter().enumerate() {
        if index > 0 {
            tokio::time::sleep(Duration::from_secs(15)).await;
        }
        for arm in &f.arms {
            evaluator.records.lock().unwrap().clear();
            let llm = Llm {
                remote: remote.clone(),
                client: http.clone(),
                key: key.clone(),
                model: model.clone(),
                endpoint,
                metrics: Mutex::new(GenerationMetrics::default()),
                total_calls: total_calls.clone(),
            };
            let server = SimulatedClient {
                card: Mutex::new(f.input["openCard"].clone()),
                actions: Mutex::new(Vec::new()),
            };
            let run: CloudAgentRun = serde_json::from_value(
                json!({"runId":format!("{}_synthetic",f.consumer),"status":"running","sessionId":"synthetic-session","ownerAccountId":"alice","requesterAccountId":"alice","providerAuthAvailable":true,"prompt":f.input.to_string(),"systemPrompt":prompt(&f.consumer)}),
            )?;
            let router = if arm == "baseline" { &off } else { &on };
            let start = Instant::now();
            let result = if f.consumer == "pip" {
                kordi_cloud_agent_runner::pip::run_with_router(
                    &server,
                    &llm,
                    &run,
                    material(),
                    router,
                )
                .await
            } else {
                kordi_cloud_agent_runner::digest::run_with_router(&llm, &run, material(), router)
                    .await
            };
            let elapsed = start.elapsed().as_millis() as u64;
            let output = result
                .as_ref()
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(text).ok());
            let metrics = llm.metrics.lock().unwrap().clone();
            let actions = server.actions.lock().unwrap().clone();
            let eval = evaluator.records.lock().unwrap().clone();
            let passed = output.as_ref().map(|o| quality(f, o, &actions));
            println!(
                "{}",
                json!({"type":"arm","case":f.id,"consumer":f.consumer,"material":f.material,"expected":f.expected,"arm":arm,"elapsedMs":elapsed,"generation":metrics,"reportedUsageComplete":metrics.calls == metrics.responses.len() as u64,"evaluation":eval,"actions":actions,"output":output,"error":result.as_ref().err().map(ToString::to_string),"qualityCheckPassed":passed})
            );
            if result.is_err() {
                anyhow::bail!("Generation failed; partial benchmark retained");
            }
        }
    }
    println!("{}", json!({"type":"complete","cases":fixtures.len()}));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use kordi_cloud_agent_runner::client::CloudAgentRunClient;
    #[test]
    fn fixture_schedule_is_balanced_and_prompts_are_real() {
        let suite: Value = serde_json::from_str(include_str!("savings/fixtures.json")).unwrap();
        let cases: Vec<Fixture> = serde_json::from_value(suite["cases"].clone()).unwrap();
        assert_eq!(cases.len(), 12);
        assert_eq!(cases.iter().filter(|c| c.arms[0] == "baseline").count(), 6);
        for consumer in ["pip", "digest"] {
            assert_eq!(cases.iter().filter(|c| c.consumer == consumer).count(), 6);
            assert_eq!(
                cases
                    .iter()
                    .filter(|c| c.consumer == consumer && !c.material)
                    .count(),
                2
            );
            assert!(prompt(consumer).len() > 1000);
        }
    }
    #[tokio::test]
    async fn rejected_simulated_tool_calls_do_not_count_as_successful_actions() {
        let client = SimulatedClient {
            card: Mutex::new(json!({"eventId":"e","revision":2,"participants":[]})),
            actions: Mutex::new(Vec::new()),
        };
        let result = client
            .plan_card_action(
                "synthetic",
                json!({"action":"cancel","eventId":"e","revision":1}),
            )
            .await
            .unwrap();
        assert!(result.get("error").is_some());
        assert!(client.actions.lock().unwrap().is_empty());
        assert_eq!(client.card.lock().unwrap()["revision"], 2);
    }
}

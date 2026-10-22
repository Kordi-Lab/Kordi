//! Metadata for host-admitted, single-query native searches.
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::StreamEvent;

pub(crate) fn options(tools: &[Value]) -> Option<&Value> {
    tools.iter().find_map(|tool| {
        (tool["function"]["name"] == "web_search")
            .then(|| tool["function"].get("search_options"))
            .flatten()
    })
}

pub(crate) fn configure_responses(body: &mut Value, tools: &[Value]) {
    let Some(options) = options(tools) else {
        return;
    };
    body["tool_choice"] = json!({"type": "web_search"});
    let includes = body
        .as_object_mut()
        .unwrap()
        .entry("include")
        .or_insert(json!([]));
    includes
        .as_array_mut()
        .unwrap()
        .push(json!("web_search_call.action.sources"));
    if let Some(domains) = options.get("allowed_domains")
        && let Some(search) = body["tools"]
            .as_array_mut()
            .and_then(|tools| tools.iter_mut().find(|tool| tool["type"] == "web_search"))
    {
        search["filters"] = json!({"allowed_domains": domains});
    }
}

/// Preserve official source metadata, including providers that send it only in
/// the terminal response. The tool collector deduplicates repeated source URLs.
pub(crate) fn responses_sources(event: &Value, tx: &mpsc::UnboundedSender<StreamEvent>) {
    let mut sources = Vec::new();
    if event["type"] == "response.output_text.annotation.added" {
        citation(&event["annotation"], &mut sources);
    }
    if event["type"] == "response.output_item.done" {
        item_sources(&event["item"], &mut sources);
    }
    if let Some(output) = event["response"]["output"].as_array() {
        for item in output {
            item_sources(item, &mut sources);
        }
    }
    if !sources.is_empty() {
        let _ = tx.send(StreamEvent::ServerToolResult {
            tool_use_id: "native-web-search".into(),
            name: "web_search".into(),
            result: json!({"sources": sources}),
            is_error: false,
        });
    }
}

fn citation(value: &Value, sources: &mut Vec<Value>) {
    if let Some(url) = value["url"].as_str() {
        sources.push(json!({"url":url,"title":value["title"].as_str().unwrap_or(url)}));
    }
}

fn item_sources(item: &Value, sources: &mut Vec<Value>) {
    if item["type"] == "web_search_call"
        && let Some(values) = item["action"]["sources"].as_array()
    {
        for value in values {
            citation(value, sources);
        }
    }
    if item["type"] == "message"
        && let Some(content) = item["content"].as_array()
    {
        for block in content {
            if let Some(values) = block["annotations"].as_array() {
                for value in values {
                    citation(value, sources);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;

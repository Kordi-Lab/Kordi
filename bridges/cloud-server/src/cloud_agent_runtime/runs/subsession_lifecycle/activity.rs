//! Tool progress is run activity, never transcript content. One bounded,
//! ordered tool list per run keeps long runs out of the message history.
use serde_json::{json, Value};

/// Most recent tool entries kept per run; `toolCount` keeps the exact total.
pub(crate) const ACTIVITY_TOOL_LIMIT: usize = 200;

fn tools(activity: &Value) -> Vec<Value> {
    activity["tools"].as_array().cloned().unwrap_or_default()
}

fn count(activity: &Value, tools: &[Value]) -> u64 {
    activity["toolCount"]
        .as_u64()
        .unwrap_or(0)
        .max(tools.len() as u64)
}

/// Records a started tool call: earlier running calls are complete, the new
/// call is the single running entry. Repeated reports of one call are no-ops.
pub(crate) fn record_tool(activity: &Value, call_id: &str, name: &str) -> Value {
    let mut tools = tools(activity);
    let total = count(activity, &tools);
    if tools.iter().any(|tool| tool["id"] == call_id) {
        return json!({"tools":tools,"toolCount":total});
    }
    for tool in &mut tools {
        if tool["status"] == "running" {
            tool["status"] = json!("completed");
        }
    }
    tools.push(json!({"id":call_id,"name":name,"status":"running","arguments":"","liveOutput":"","isError":false}));
    let excess = tools.len().saturating_sub(ACTIVITY_TOOL_LIMIT);
    tools.drain(..excess);
    json!({"tools":tools,"toolCount":total + 1})
}

/// A finished run has no running tool.
pub(crate) fn settle(activity: &Value) -> Value {
    let mut tools = tools(activity);
    let total = count(activity, &tools);
    for tool in &mut tools {
        if tool["status"] == "running" {
            tool["status"] = json!("completed");
        }
    }
    json!({"tools":tools,"toolCount":total})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_keeps_one_running_tool_and_a_count() {
        let mut activity = json!({"tools":[]});
        for (id, name) in [
            ("a", "search_sessions"),
            ("b", "read_session"),
            ("c", "search_sessions"),
        ] {
            activity = record_tool(&activity, id, name);
        }
        let tools = activity["tools"].as_array().unwrap();
        assert_eq!(activity["toolCount"], 3);
        assert_eq!(tools.len(), 3);
        assert_eq!(
            tools
                .iter()
                .filter(|tool| tool["status"] == "running")
                .count(),
            1
        );
        assert_eq!(tools[2]["id"], "c");
        assert_eq!(tools[2]["status"], "running");
        assert_eq!(record_tool(&activity, "c", "search_sessions"), activity);
        let settled = settle(&activity);
        assert!(settled["tools"]
            .as_array()
            .unwrap()
            .iter()
            .all(|tool| tool["status"] == "completed"));
        assert_eq!(settled["toolCount"], 3);
    }

    #[test]
    fn progress_stays_bounded_for_long_runs() {
        let mut activity = json!({});
        for index in 0..(ACTIVITY_TOOL_LIMIT + 50) {
            activity = record_tool(&activity, &format!("call-{index}"), "read_session");
        }
        let tools = activity["tools"].as_array().unwrap();
        assert_eq!(tools.len(), ACTIVITY_TOOL_LIMIT);
        assert_eq!(activity["toolCount"], (ACTIVITY_TOOL_LIMIT + 50) as u64);
        assert_eq!(
            tools.last().unwrap()["id"],
            format!("call-{}", ACTIVITY_TOOL_LIMIT + 49)
        );
    }
}

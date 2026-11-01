//! Both engines advertise only communication tools backed by this turn's runtime.
use kordi_tools::ToolContext;
use serde_json::Value;

pub(crate) fn available_definitions(definitions: &[Value], context: &ToolContext) -> Vec<Value> {
    filter_definitions(definitions, context.reach_out.is_some())
}

fn filter_definitions(definitions: &[Value], outreach: bool) -> Vec<Value> {
    definitions
        .iter()
        .filter(|definition| {
            outreach
                || definition.pointer("/function/name").and_then(Value::as_str) != Some("reach_out")
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unconfigured_outreach_is_not_advertised_and_other_tools_keep_their_order() {
        let definitions = vec![
            json!({"function":{"name":"read_session"}}),
            json!({"function":{"name":"reach_out"}}),
            json!({"function":{"name":"web_search"}}),
        ];
        assert_eq!(
            filter_definitions(&definitions, false),
            vec![definitions[0].clone(), definitions[2].clone()]
        );
        assert_eq!(filter_definitions(&definitions, true), definitions);
    }
}

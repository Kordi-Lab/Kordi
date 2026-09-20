use crate::{
    client::ProviderAuthMaterial,
    model_loop::{CloudModelProvider, ModelLoopError, ModelProviderResponse, OpenAiProviderConfig},
};
use serde_json::{json, Value};

pub(super) fn configured() -> Result<Option<OpenAiProviderConfig>, ModelLoopError> {
    from_lookup(|key| std::env::var(key).ok())
}

fn from_lookup(
    get: impl Fn(&str) -> Option<String>,
) -> Result<Option<OpenAiProviderConfig>, ModelLoopError> {
    let key = get("KORDI_PIP_FALLBACK_API_KEY").unwrap_or_default();
    if key.trim().is_empty() {
        return Ok(None);
    }
    let base = get("KORDI_PIP_FALLBACK_BASE_URL").unwrap_or_default();
    let model = get("KORDI_PIP_FALLBACK_MODEL").unwrap_or_default();
    let url = reqwest::Url::parse(base.trim())
        .map_err(|_| ModelLoopError::Provider("Invalid PiP fallback base URL".into()))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || model.trim().is_empty()
    {
        return Err(ModelLoopError::Provider(
            "PiP fallback requires an HTTPS base URL and a model".into(),
        ));
    }
    OpenAiProviderConfig::from_material(&ProviderAuthMaterial {
        snapshot_id: "pip-fallback".into(),
        provider: "openai-compatible".into(),
        auth_choice: "api-key".into(),
        payload: json!({"apiKey":key,"baseUrl":base,"model":model}),
    })
    .map(Some)
}

/// Switch once, keeping the current message/tool history and all completed actions.
pub(super) async fn next_response<P: CloudModelProvider + Sync>(
    provider: &P,
    auth: &mut OpenAiProviderConfig,
    fallback: &mut Option<OpenAiProviderConfig>,
    messages: &[Value],
    tools: &[Value],
) -> Result<ModelProviderResponse, ModelLoopError> {
    let response = if fallback.is_some() {
        tokio::time::timeout(
            std::time::Duration::from_secs(90),
            provider.next_response(auth, messages, tools),
        )
        .await
        .unwrap_or_else(|_| {
            Err(ModelLoopError::Provider(
                "PiP primary provider timed out".into(),
            ))
        })
    } else {
        provider.next_response(auth, messages, tools).await
    };
    match response {
        Err(ModelLoopError::Provider(_)) if fallback.is_some() => {
            *auth = fallback.take().expect("fallback was checked");
            tracing::warn!(model = %auth.model, "pip provider fallback activated");
            provider.next_response(auth, messages, tools).await
        }
        result => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::Mutex;

    fn fallback() -> OpenAiProviderConfig {
        from_lookup(|key| match key {
            "KORDI_PIP_FALLBACK_API_KEY" => Some("synthetic".into()),
            "KORDI_PIP_FALLBACK_BASE_URL" => Some("https://example.com/v1".into()),
            "KORDI_PIP_FALLBACK_MODEL" => Some("deepseek-v4.1-flash".into()),
            _ => None,
        })
        .unwrap()
        .unwrap()
    }

    #[test]
    fn optional_configuration_preserves_the_exact_fallback_model() {
        assert!(from_lookup(|_| None).unwrap().is_none());
        assert_eq!(fallback().model, "deepseek-v4.1-flash");
        assert!(from_lookup(|_| Some("invalid".into())).is_err());
    }

    struct Provider {
        models: Mutex<Vec<String>>,
        fail_fallback: bool,
    }
    #[async_trait]
    impl CloudModelProvider for Provider {
        async fn next_response(
            &self,
            auth: &OpenAiProviderConfig,
            messages: &[Value],
            _: &[Value],
        ) -> Result<ModelProviderResponse, ModelLoopError> {
            self.models.lock().unwrap().push(auth.model.clone());
            assert_eq!(messages.last().unwrap()["role"], "tool");
            if auth.model == "primary" || self.fail_fallback {
                return Err(ModelLoopError::Provider("credits exhausted".into()));
            }
            Ok(ModelProviderResponse::FinalText("done".into()))
        }
    }

    #[tokio::test]
    async fn provider_failure_switches_once_without_replaying_prior_tool_history() {
        let provider = Provider {
            models: Mutex::new(vec![]),
            fail_fallback: false,
        };
        let mut auth = fallback();
        auth.model = "primary".into();
        let mut backup = Some(fallback());
        let messages =
            vec![json!({"role":"tool","tool_call_id":"already-applied","content":"success"})];
        next_response(&provider, &mut auth, &mut backup, &messages, &[])
            .await
            .unwrap();
        next_response(&provider, &mut auth, &mut backup, &messages, &[])
            .await
            .unwrap();
        assert_eq!(
            *provider.models.lock().unwrap(),
            vec!["primary", "deepseek-v4.1-flash", "deepseek-v4.1-flash"]
        );
        assert!(backup.is_none());
    }

    #[tokio::test]
    async fn healthy_primary_never_uses_the_fallback() {
        let provider = Provider {
            models: Mutex::new(vec![]),
            fail_fallback: false,
        };
        let mut auth = fallback();
        auth.model = "healthy-primary".into();
        let mut backup = Some(fallback());
        next_response(
            &provider,
            &mut auth,
            &mut backup,
            &[json!({"role":"tool"})],
            &[],
        )
        .await
        .unwrap();
        assert_eq!(*provider.models.lock().unwrap(), vec!["healthy-primary"]);
        assert!(backup.is_some());
    }

    #[tokio::test]
    async fn fallback_failure_returns_an_error_without_a_retry_loop() {
        let provider = Provider {
            models: Mutex::new(vec![]),
            fail_fallback: true,
        };
        let mut auth = fallback();
        auth.model = "primary".into();
        let mut backup = Some(fallback());
        assert!(next_response(
            &provider,
            &mut auth,
            &mut backup,
            &[json!({"role":"tool"})],
            &[]
        )
        .await
        .is_err());
        assert_eq!(provider.models.lock().unwrap().len(), 2);
    }
    #[tokio::test]
    #[ignore = "requires explicit synthetic testing with private fallback credentials"]
    async fn live_compatible_fallback_tool_round_trip() {
        let auth = configured()
            .unwrap()
            .expect("fallback credentials required");
        let provider = crate::model_loop::OpenAiCompatibleProvider::default();
        let tools = crate::pip::tools();
        let mut messages = vec![
            json!({"role":"system","content":"Synthetic integration test. Call the requested plan_card action exactly once. After its successful result, return only {\"message\":\"Test response recorded\",\"hooksHandled\":[]}."}),
            json!({"role":"user","content":"Use plan_card to record RSVP yes for participant synthetic-member on event synthetic-plan."}),
        ];
        let ModelProviderResponse::ToolCalls(calls) = provider
            .next_response(&auth, &messages, &tools)
            .await
            .unwrap()
        else {
            panic!("expected a tool call")
        };
        assert_eq!(calls.len(), 1);
        let call = &calls[0];
        assert_eq!(call.name, "plan_card");
        assert_eq!(call.arguments["action"], "rsvp");
        messages.push(json!({"role":"assistant","tool_calls":[{"id":call.id,"type":"function","function":{"name":call.name,"arguments":call.arguments.to_string()}}]}));
        messages.push(json!({"role":"tool","tool_call_id":call.id,"content":"{\"eventId\":\"synthetic-plan\",\"revision\":2,\"state\":\"awaiting_confirmation\",\"success\":true}"}));
        let ModelProviderResponse::FinalText(text) = provider
            .next_response(&auth, &messages, &tools)
            .await
            .unwrap()
        else {
            panic!("expected a final response")
        };
        assert!(!text.trim().is_empty());
    }
}

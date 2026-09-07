use serde::Deserialize;

#[derive(Deserialize)]
pub(super) struct ProviderAuthMutationQuery {
    intent: Option<String>,
}

impl ProviderAuthMutationQuery {
    pub(super) fn is_explicit(&self) -> bool {
        self.intent.as_deref().map(str::trim) == Some("explicit")
    }
}

#[cfg(test)]
mod tests {
    use super::ProviderAuthMutationQuery;

    #[test]
    fn mutations_require_explicit_intent() {
        assert!(ProviderAuthMutationQuery {
            intent: Some("explicit".to_string()),
        }
        .is_explicit());
        assert!(!ProviderAuthMutationQuery { intent: None }.is_explicit());
        assert!(!ProviderAuthMutationQuery {
            intent: Some("passive".to_string()),
        }
        .is_explicit());
    }
}

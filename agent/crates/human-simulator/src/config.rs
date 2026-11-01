use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const MAX_ACCOUNT_ID_CHARS: usize = 128;
const MAX_OBJECTIVE_CHARS: usize = 8_000;
const MAX_PERSONA_CHARS: usize = 8_000;
const MAX_PRIVATE_FACTS: usize = 100;
const MAX_PRIVATE_FACT_CHARS: usize = 8_000;

fn default_poll_seconds() -> u64 {
    5
}

fn default_max_wait_seconds() -> u64 {
    60
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ActorConfig {
    pub actor_id: String,
    pub account_id: String,
    pub conversation_id: Uuid,
    pub objective: String,
    #[serde(default)]
    pub persona: String,
    #[serde(default)]
    pub private_facts: Vec<String>,
    pub skill: String,
    pub max_model_calls: u32,
    pub max_messages: u32,
    #[serde(default = "default_poll_seconds")]
    pub poll_seconds: u64,
    #[serde(default = "default_max_wait_seconds")]
    pub max_wait_seconds: u64,
}

impl ActorConfig {
    pub fn validate(&self) -> Result<()> {
        if self.actor_id.is_empty()
            || self.actor_id.len() > 64
            || !self
                .actor_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        {
            bail!("actor_id must contain 1 to 64 ASCII letters, digits, '-' or '_'");
        }
        if self.account_id.trim().is_empty()
            || self.account_id.chars().count() > MAX_ACCOUNT_ID_CHARS
        {
            bail!("account_id must contain 1 to {MAX_ACCOUNT_ID_CHARS} characters");
        }
        if self.objective.trim().is_empty() || self.objective.chars().count() > MAX_OBJECTIVE_CHARS
        {
            bail!("objective must contain 1 to {MAX_OBJECTIVE_CHARS} characters");
        }
        if self.persona.chars().count() > MAX_PERSONA_CHARS {
            bail!("persona must contain at most {MAX_PERSONA_CHARS} characters");
        }
        if self.private_facts.len() > MAX_PRIVATE_FACTS {
            bail!("private_facts must contain at most {MAX_PRIVATE_FACTS} entries");
        }
        if self
            .private_facts
            .iter()
            .any(|fact| fact.chars().count() > MAX_PRIVATE_FACT_CHARS)
        {
            bail!("each private fact must contain at most {MAX_PRIVATE_FACT_CHARS} characters");
        }
        if self.skill != "human-requester@1" {
            bail!("skill must be human-requester@1");
        }
        if !(1..=1_000).contains(&self.max_model_calls) {
            bail!("max_model_calls must be between 1 and 1000");
        }
        if !(1..=1_000).contains(&self.max_messages) {
            bail!("max_messages must be between 1 and 1000");
        }
        if !(1..=300).contains(&self.poll_seconds) {
            bail!("poll_seconds must be between 1 and 300");
        }
        if !(1..=3_600).contains(&self.max_wait_seconds) {
            bail!("max_wait_seconds must be between 1 and 3600");
        }
        Ok(())
    }

    /// Hash the deterministic JSON representation of this struct.
    pub fn fingerprint(&self) -> String {
        let value =
            serde_json::to_value(self).expect("ActorConfig contains only serializable values");
        let canonical_json =
            serde_json::to_vec(&value).expect("ActorConfig contains only serializable values");
        let digest = Sha256::digest(canonical_json);
        digest.iter().map(|byte| format!("{byte:02x}")).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn valid_config_json() -> serde_json::Value {
        json!({
            "actor_id": "actor_01",
            "account_id": "account-1",
            "conversation_id": "00000000-0000-0000-0000-000000000001",
            "objective": "Ask for a concise summary.",
            "skill": "human-requester@1",
            "max_model_calls": 10,
            "max_messages": 20
        })
    }

    fn config_from(value: serde_json::Value) -> ActorConfig {
        serde_json::from_value(value).expect("valid config JSON")
    }

    #[test]
    fn deserialization_applies_optional_defaults_and_serializes_snake_case_fields() {
        let config = config_from(valid_config_json());
        assert_eq!(config.persona, "");
        assert!(config.private_facts.is_empty());
        assert_eq!(config.poll_seconds, 5);
        assert_eq!(config.max_wait_seconds, 60);
        config.validate().expect("valid config");

        let serialized = serde_json::to_value(&config).expect("serialize config");
        assert_eq!(serialized["actor_id"], "actor_01");
        assert_eq!(serialized["max_model_calls"], 10);
        assert!(serialized.get("actorId").is_none());
    }

    #[test]
    fn rejects_unknown_fields_and_invalid_ids_or_skill() {
        let mut unknown = valid_config_json();
        unknown["endpoint"] = json!("https://example.invalid");
        assert!(serde_json::from_value::<ActorConfig>(unknown).is_err());

        let mut invalid_id = config_from(valid_config_json());
        invalid_id.actor_id = "actor/id".into();
        assert!(invalid_id.validate().is_err());

        let mut invalid_skill = config_from(valid_config_json());
        invalid_skill.skill = "other@1".into();
        assert!(invalid_skill.validate().is_err());
    }

    #[test]
    fn validates_required_strings_and_numeric_limits() {
        for (field, value) in [
            ("max_model_calls", json!(0)),
            ("max_model_calls", json!(1_001)),
            ("max_messages", json!(0)),
            ("max_messages", json!(1_001)),
            ("poll_seconds", json!(0)),
            ("poll_seconds", json!(301)),
            ("max_wait_seconds", json!(0)),
            ("max_wait_seconds", json!(3_601)),
        ] {
            let mut input = valid_config_json();
            input[field] = value;
            assert!(config_from(input).validate().is_err(), "accepted {field}");
        }

        let mut empty_objective = config_from(valid_config_json());
        empty_objective.objective = "  ".into();
        assert!(empty_objective.validate().is_err());

        let mut upper_bounds = config_from(valid_config_json());
        upper_bounds.max_model_calls = 1_000;
        upper_bounds.max_messages = 1_000;
        upper_bounds.poll_seconds = 300;
        upper_bounds.max_wait_seconds = 3_600;
        upper_bounds.validate().expect("inclusive upper bounds");
    }

    #[test]
    fn validates_config_string_lengths() {
        let mut too_long_actor_id = config_from(valid_config_json());
        too_long_actor_id.actor_id = "a".repeat(65);
        assert!(too_long_actor_id.validate().is_err());

        let mut too_long_account_id = config_from(valid_config_json());
        too_long_account_id.account_id = "a".repeat(MAX_ACCOUNT_ID_CHARS + 1);
        assert!(too_long_account_id.validate().is_err());

        let mut too_long_objective = config_from(valid_config_json());
        too_long_objective.objective = "a".repeat(MAX_OBJECTIVE_CHARS + 1);
        assert!(too_long_objective.validate().is_err());

        let mut too_long_persona = config_from(valid_config_json());
        too_long_persona.persona = "a".repeat(MAX_PERSONA_CHARS + 1);
        assert!(too_long_persona.validate().is_err());

        let mut too_many_facts = config_from(valid_config_json());
        too_many_facts.private_facts = vec![String::new(); MAX_PRIVATE_FACTS + 1];
        assert!(too_many_facts.validate().is_err());

        let mut too_long_fact = config_from(valid_config_json());
        too_long_fact.private_facts = vec!["a".repeat(MAX_PRIVATE_FACT_CHARS + 1)];
        assert!(too_long_fact.validate().is_err());
    }

    #[test]
    fn fingerprint_is_stable_for_the_same_config() {
        let config = config_from(valid_config_json());
        assert_eq!(config.fingerprint(), config.fingerprint());
        assert_eq!(config.fingerprint().len(), 64);
    }
}

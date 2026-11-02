use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

const MAX_TEXT_CHARS: usize = 8_000;
const MAX_MEMORY_CHARS: usize = 8_000;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Decision {
    Send { text: String, memory: String },
    Wait { seconds: u64, memory: String },
    Finish { memory: String },
}

impl Decision {
    pub fn validate(&self, max_wait_seconds: u64) -> Result<()> {
        match self {
            Self::Send { text, memory } => {
                if text.trim().is_empty() {
                    bail!("send text must not be empty");
                }
                if text.chars().count() > MAX_TEXT_CHARS {
                    bail!("send text must contain at most {MAX_TEXT_CHARS} characters");
                }
                Self::validate_memory(memory)?;
            }
            Self::Wait { seconds, memory } => {
                if !(1..=max_wait_seconds).contains(seconds) {
                    bail!("wait seconds must be between 1 and {max_wait_seconds}");
                }
                Self::validate_memory(memory)?;
            }
            Self::Finish { memory } => Self::validate_memory(memory)?,
        }
        Ok(())
    }

    fn validate_memory(memory: &str) -> Result<()> {
        if memory.chars().count() > MAX_MEMORY_CHARS {
            bail!("memory must contain at most {MAX_MEMORY_CHARS} characters");
        }
        Ok(())
    }

    pub fn memory(&self) -> &str {
        match self {
            Self::Send { memory, .. } | Self::Wait { memory, .. } | Self::Finish { memory } => {
                memory
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn serializes_and_deserializes_the_action_schema() {
        let decision = Decision::Send {
            text: "Could you summarize this?".into(),
            memory: "Asked for a summary.".into(),
        };
        let value = serde_json::to_value(&decision).expect("serialize decision");
        assert_eq!(
            value,
            json!({
                "action": "send",
                "text": "Could you summarize this?",
                "memory": "Asked for a summary."
            })
        );
        assert_eq!(serde_json::from_value::<Decision>(value).unwrap(), decision);
        assert_eq!(decision.memory(), "Asked for a summary.");

        assert_eq!(
            serde_json::to_value(Decision::Wait {
                seconds: 2,
                memory: "Waiting.".into()
            })
            .unwrap(),
            json!({"action": "wait", "seconds": 2, "memory": "Waiting."})
        );
        assert_eq!(
            serde_json::to_value(Decision::Finish {
                memory: "Done.".into()
            })
            .unwrap(),
            json!({"action": "finish", "memory": "Done."})
        );
    }

    #[test]
    fn rejects_unknown_fields_and_invalid_values() {
        assert!(
            serde_json::from_value::<Decision>(json!({
                "action": "finish",
                "memory": "done",
                "extra": true
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<Decision>(json!({
                "action": "unknown",
                "memory": "done"
            }))
            .is_err()
        );

        assert!(
            Decision::Send {
                text: "  ".into(),
                memory: String::new()
            }
            .validate(10)
            .is_err()
        );
        assert!(
            Decision::Wait {
                seconds: 0,
                memory: String::new()
            }
            .validate(10)
            .is_err()
        );
        assert!(
            Decision::Wait {
                seconds: 11,
                memory: String::new()
            }
            .validate(10)
            .is_err()
        );
        assert!(
            Decision::Finish {
                memory: "m".repeat(MAX_MEMORY_CHARS + 1)
            }
            .validate(10)
            .is_err()
        );
        assert!(
            Decision::Send {
                text: "t".repeat(MAX_TEXT_CHARS + 1),
                memory: String::new()
            }
            .validate(10)
            .is_err()
        );
    }
}

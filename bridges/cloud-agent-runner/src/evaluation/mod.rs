//! Bounded, typed judgments. This API never generates text or executes tools.
pub mod routing;
mod transport;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub use transport::JevProvider;

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Question {
    Choice {
        instructions: String,
        criteria: BTreeMap<String, String>,
    },
    Noul {
        instructions: String,
    },
    Score {
        instructions: String,
        criteria: Vec<String>,
    },
}

#[derive(Clone, Debug, Serialize)]
pub struct EvaluationRequest {
    pub state: Value,
    pub questions: BTreeMap<String, Question>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Answer {
    Choice {
        choice: String,
        probabilities: BTreeMap<String, f64>,
        confidence: Option<f64>,
    },
    Noul {
        noul: f64,
    },
    Score {
        score: f64,
        legend: BTreeMap<String, String>,
        probabilities: BTreeMap<String, f64>,
        confidence: Option<f64>,
    },
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct EvaluationResponse {
    pub model: String,
    pub answers: BTreeMap<String, Answer>,
    pub usage: Usage,
}

#[derive(Clone, Copy, Debug, thiserror::Error, PartialEq, Eq)]
pub enum EvaluationError {
    #[error("evaluation input exceeds budget")]
    Budget,
    #[error("evaluation response invalid")]
    Invalid,
    #[error("evaluation unavailable")]
    Unavailable,
    #[error("evaluation timed out")]
    Timeout,
    #[error("evaluation HTTP status {0}")]
    Http(u16),
}

fn probability(value: f64) -> bool {
    value.is_finite() && (0.0..=1.0).contains(&value)
}
fn distribution(values: &BTreeMap<String, f64>) -> bool {
    !values.is_empty()
        && values.values().all(|v| probability(*v))
        && (values.values().sum::<f64>() - 1.0).abs() <= 0.01
}

impl EvaluationRequest {
    pub fn validate(&self) -> Result<(), EvaluationError> {
        if self.questions.is_empty()
            || self.questions.len() > 16
            || serde_json::to_vec(self)
                .map_err(|_| EvaluationError::Invalid)?
                .len()
                > 48_000
        {
            return Err(EvaluationError::Budget);
        }
        for question in self.questions.values() {
            let valid = match question {
                Question::Choice {
                    instructions,
                    criteria,
                } => !instructions.is_empty() && (2..=64).contains(&criteria.len()),
                Question::Noul { instructions } => !instructions.is_empty(),
                Question::Score {
                    instructions,
                    criteria,
                } => !instructions.is_empty() && (2..=16).contains(&criteria.len()),
            };
            if !valid {
                return Err(EvaluationError::Invalid);
            }
        }
        Ok(())
    }
}

impl EvaluationResponse {
    pub fn validate(&self, request: &EvaluationRequest) -> Result<(), EvaluationError> {
        if self.model.is_empty() || self.answers.keys().ne(request.questions.keys()) {
            return Err(EvaluationError::Invalid);
        }
        for (key, question) in &request.questions {
            let valid = match (question, &self.answers[key]) {
                (
                    Question::Choice { criteria, .. },
                    Answer::Choice {
                        choice,
                        probabilities,
                        confidence,
                    },
                ) => {
                    criteria.keys().eq(probabilities.keys())
                        && confidence.is_none_or(probability)
                        && distribution(probabilities)
                        && probabilities
                            .get(choice)
                            .is_some_and(|p| probabilities.values().all(|other| p >= other))
                }
                (Question::Noul { .. }, Answer::Noul { noul }) => probability(*noul),
                (
                    Question::Score { criteria, .. },
                    Answer::Score {
                        score,
                        legend,
                        probabilities,
                        confidence,
                    },
                ) => {
                    let expected: BTreeMap<_, _> = criteria
                        .iter()
                        .enumerate()
                        .map(|(i, label)| (i.to_string(), label.clone()))
                        .collect();
                    legend == &expected
                        && legend.keys().eq(probabilities.keys())
                        && distribution(probabilities)
                        && confidence.is_none_or(probability)
                        && score.is_finite()
                        && (0.0..=(criteria.len() - 1) as f64).contains(score)
                }
                _ => false,
            };
            if !valid {
                return Err(EvaluationError::Invalid);
            }
        }
        Ok(())
    }

    /// Native confidence and selected probability are separate requirements.
    /// Gateway omits confidence; require a stricter probability instead of inventing one.
    pub fn choice(&self, key: &str, threshold: f64) -> Option<&str> {
        match self.answers.get(key)? {
            Answer::Choice {
                choice,
                probabilities,
                confidence,
            } if match confidence {
                Some(confidence) => {
                    *confidence >= threshold && *probabilities.get(choice)? >= threshold
                }
                None => *probabilities.get(choice)? >= if threshold >= 0.98 { 0.995 } else { 0.95 },
            } =>
            {
                Some(choice)
            }
            _ => None,
        }
    }
}

#[async_trait]
pub trait EvaluationProvider: Send + Sync {
    async fn evaluate(
        &self,
        request: &EvaluationRequest,
    ) -> Result<EvaluationResponse, EvaluationError>;
}

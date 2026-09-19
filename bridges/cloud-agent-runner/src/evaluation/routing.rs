//! Consumer policies and process-local evaluation budgets. Disabled by default.
mod policy;
#[cfg(test)]
mod tests;

use super::{
    EvaluationError, EvaluationProvider, EvaluationRequest, EvaluationResponse, JevProvider,
};
use crate::client::CloudAgentRun;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Mode {
    #[default]
    Off,
    Shadow,
    Enabled,
}
impl Mode {
    pub fn parse(value: &str) -> Self {
        match value.trim() {
            "shadow" => Self::Shadow,
            "enabled" => Self::Enabled,
            _ => Self::Off,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Consumer {
    Pip,
    Digest,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Route {
    #[default]
    Generate,
    Skip,
    /// Arguments still come from the generation model and server validation is unchanged.
    PlanCard {
        action: String,
    },
    /// The session is chosen from the frozen, authorized observation snapshot.
    ReadSession {
        session_id: String,
    },
    SearchSessions,
}
impl Route {
    fn label(&self) -> &'static str {
        match self {
            Self::Generate => "generate",
            Self::Skip => "skip",
            Self::PlanCard { .. } => "plan_card",
            Self::ReadSession { .. } => "read_session",
            Self::SearchSessions => "search_sessions",
        }
    }
}

struct CacheEntry {
    response: EvaluationResponse,
    expires: Instant,
}
#[derive(Default)]
struct Health {
    failures: usize,
    open_until: Option<Instant>,
    cache: HashMap<[u8; 32], CacheEntry>,
}

pub struct Router {
    provider: Option<Arc<dyn EvaluationProvider>>,
    pip: Mode,
    digest: Mode,
    model_version: String,
    capacity: Semaphore,
    health: Mutex<Health>,
    deadline: Duration,
}

impl Router {
    pub fn new(
        provider: Option<Arc<dyn EvaluationProvider>>,
        model_version: String,
        pip: Mode,
        digest: Mode,
    ) -> Self {
        Self {
            provider,
            model_version,
            pip,
            digest,
            capacity: Semaphore::new(4),
            health: Mutex::new(Health::default()),
            deadline: Duration::from_secs(2),
        }
    }

    fn from_env() -> Self {
        let pip = Mode::parse(&std::env::var("KORDI_JEV_PIP_MODE").unwrap_or_default());
        let digest = Mode::parse(&std::env::var("KORDI_JEV_DIGEST_MODE").unwrap_or_default());
        let configured = if pip == Mode::Off && digest == Mode::Off {
            None
        } else {
            JevProvider::from_env().ok()
        };
        let model = configured
            .as_ref()
            .map(|p| p.model.clone())
            .unwrap_or_default();
        let provider = configured.map(|p| Arc::new(p) as Arc<dyn EvaluationProvider>);
        Self::new(provider, model, pip, digest)
    }

    pub async fn route(
        &self,
        consumer: Consumer,
        run: &CloudAgentRun,
        input: &Value,
        context: &Value,
    ) -> Route {
        let mode = match consumer {
            Consumer::Pip => self.pip,
            Consumer::Digest => self.digest,
        };
        if mode == Mode::Off {
            return Route::Generate;
        }
        let started = Instant::now();
        let Some(plan) = policy::plan(consumer, input, context) else {
            return Route::Generate;
        };
        let (proposed, reason, cache_hit, usage) = match plan {
            policy::Plan::Skip => (Route::Skip, "deterministic", false, None),
            policy::Plan::Evaluate {
                request,
                sessions,
                allow_skip,
            } => match self.evaluate(run, input, consumer, &request).await {
                Ok((response, cached)) => {
                    let route = policy::interpret(consumer, &response, &sessions, allow_skip);
                    (route, "evaluated", cached, Some(response.usage))
                }
                Err(error) => {
                    tracing::info!(?consumer, ?error, "evaluation fallback");
                    (Route::Generate, "fallback", false, None)
                }
            },
        };
        let applied = if mode == Mode::Enabled {
            proposed.clone()
        } else {
            Route::Generate
        };
        tracing::info!(
            ?consumer,
            ?mode,
            proposed = proposed.label(),
            applied = applied.label(),
            reason,
            cache_hit,
            elapsed_ms = started.elapsed().as_millis() as u64,
            input_tokens = if cache_hit {
                0
            } else {
                usage.as_ref().map_or(0, |u| u.input_tokens)
            },
            output_tokens = if cache_hit {
                0
            } else {
                usage.as_ref().map_or(0, |u| u.output_tokens)
            },
            "evaluation routing decision"
        );
        applied
    }

    async fn evaluate(
        &self,
        run: &CloudAgentRun,
        input: &Value,
        consumer: Consumer,
        request: &EvaluationRequest,
    ) -> Result<(EvaluationResponse, bool), EvaluationError> {
        request.validate()?;
        let provider = self.provider.as_ref().ok_or(EvaluationError::Unavailable)?;
        // Full input fingerprint includes edits, scope, permissions represented by the source set,
        // card revisions and clock. Never reuse merely by message ID or across accounts.
        let key: [u8; 32] = Sha256::digest(serde_json::to_vec(&serde_json::json!({
            "owner":run.owner_account_id,"requester":run.requester_account_id,"session":run.session_id,
            "system":run.system_prompt,"input":input,"request":request,
            "consumer":format!("{consumer:?}"),"rubric":"routing-v1","model":self.model_version
        })).map_err(|_| EvaluationError::Invalid)?).into();
        {
            let mut health = self.health.lock().unwrap_or_else(|e| e.into_inner());
            let now = Instant::now();
            health.cache.retain(|_, entry| entry.expires > now);
            if let Some(entry) = health.cache.get(&key) {
                return Ok((entry.response.clone(), true));
            }
            if health.open_until.is_some_and(|until| until > now) {
                return Err(EvaluationError::Unavailable);
            }
        }
        let work = async {
            let _permit = self
                .capacity
                .acquire()
                .await
                .map_err(|_| EvaluationError::Unavailable)?;
            // Recheck after waiting so queued work cannot bypass a newly opened circuit.
            if self
                .health
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .open_until
                .is_some_and(|until| until > Instant::now())
            {
                return Err(EvaluationError::Unavailable);
            }
            let response = provider.evaluate(request).await?;
            response.validate(request)?;
            Ok(response)
        };
        // Dropping this future (runner timeout/cancellation) also cancels the HTTP operation.
        let result = tokio::time::timeout(self.deadline, work)
            .await
            .unwrap_or(Err(EvaluationError::Timeout));
        let mut health = self.health.lock().unwrap_or_else(|e| e.into_inner());
        match &result {
            Ok(response) => {
                health.failures = 0;
                health.open_until = None;
                if health.cache.len() >= 128 {
                    if let Some(oldest) = health
                        .cache
                        .iter()
                        .min_by_key(|(_, entry)| entry.expires)
                        .map(|(key, _)| *key)
                    {
                        health.cache.remove(&oldest);
                    }
                }
                health.cache.insert(
                    key,
                    CacheEntry {
                        response: response.clone(),
                        expires: Instant::now() + Duration::from_secs(60),
                    },
                );
            }
            Err(_) => {
                health.failures += 1;
                if health.failures >= 3 {
                    health.open_until = Some(Instant::now() + Duration::from_secs(30));
                }
            }
        }
        result.map(|response| (response, false))
    }
}

pub fn default_router() -> &'static Router {
    static ROUTER: OnceLock<Router> = OnceLock::new();
    ROUTER.get_or_init(Router::from_env)
}

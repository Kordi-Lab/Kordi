//! `search_memory`: how a proactive run reads its owner's memories
//! (docs/development/proactive-agent.md, "Memory"). Proactive runs get no
//! memory section in their system prompt; they search for what they need.
//!
//! The search applies the rules of the prompt section
//! (`kordi_tools::memory_prompt`): the owner's global memories plus the
//! run's conversation and group, nothing when memory is off. While the
//! account excludes sensitive memories, a memory the shared guard would
//! reject as sensitive is left out too. Matches are ranked by the query words
//! they share, newest first on a tie.
//!
//! - The approved run, and an evaluation the cloud runner leases, carry the
//!   tool as a lease descriptor next to the document tools
//!   (`connectorTools`), so the Mac turn and the runner call it through the
//!   connector broker route ([`call`]).
//! - An evaluation a Mac claims gets the tool in its claim's `tools` and
//!   calls it through the digest observe route that the Mac's single-turn
//!   command already uses ([`observe`]).
//! - An evaluation gets at most [`MAX_EVALUATION_SEARCHES`] answers, counted
//!   on its group's proactive state row while it is the active evaluation
//!   ([`charge_evaluation_search`]). The Mac attempt and a cloud takeover of
//!   the same evaluation share the budget; an evaluation that is no longer
//!   active gets no answer.

use axum::http::StatusCode;
use kordi_tools::memory_guard::{check_memory_text, MemoryGuardError, MemoryGuardOptions};
use kordi_tools::memory_prompt::{MemoryRun, MemoryScopes, MemorySettings};
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::{APPROVED_RUN_PREFIX, RUN_PREFIX};
use crate::auth::routes::CloudSession;
use crate::connectors::broker::codes;
use crate::connectors::delivery::{load_active_lease, LeaseConnectorTool, LeaseHolder};
use crate::connectors::models::{BrokerCallRequest, BrokerCallResponse, ConnectorToolGroup};
use crate::server::ServerState;

/// The connector id the descriptor and the broker call carry.
pub(crate) const MEMORY_CONNECTOR_ID: &str = "kordi-memory";
const MEMORY_PROVIDER: &str = "kordi_memory";
pub(crate) const SEARCH_MEMORY_TOOL: &str = "search_memory";
const DEFAULT_LIMIT: usize = 5;
const MAX_LIMIT: usize = 10;
const MAX_QUERY_CHARS: usize = 500;
/// Answers an evaluation gets; later calls are told to answer.
pub(crate) const MAX_EVALUATION_SEARCHES: i32 = 3;

const DESCRIPTION: &str = "Search your owner's saved memories: what they own, know or maintain, where their code and files live, and how they like answers. Returns the memories that best match the query. They are private to your owner: use them silently, and never quote or mention them to anyone else.";
const PRIVATE_NOTE: &str = "These memories are private to your owner. Use them silently; never quote or mention them in the group.";
const NO_SEARCHES_LEFT: &str = "No searches are left in this run. Answer with what you have.";

fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Words to look for, such as the project, tool, file or problem, or \"preferences\"."
            },
            "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": MAX_LIMIT,
                "description": "How many memories to return. 5 by default."
            }
        },
        "required": ["query"]
    })
}

/// The lease descriptor of the tool.
pub(crate) fn descriptor() -> LeaseConnectorTool {
    LeaseConnectorTool {
        connector_id: MEMORY_CONNECTOR_ID.to_string(),
        provider: MEMORY_PROVIDER.to_string(),
        name: SEARCH_MEMORY_TOOL.to_string(),
        group: ConnectorToolGroup::Read,
        description: DESCRIPTION.to_string(),
        input_schema: schema(),
    }
}

/// The tool as a Mac evaluation claim lists it, in the digest tool shape.
pub(crate) fn mac_tool() -> Value {
    json!({"name": SEARCH_MEMORY_TOOL, "description": DESCRIPTION, "parameters": schema()})
}

/// The memory tools on `run_id`'s lease: `search_memory` for proactive runs
/// and personal agent evaluations.
pub(crate) fn lease_tools(run_id: &str) -> Vec<LeaseConnectorTool> {
    if super::desktop::is_evaluation(run_id) || run_id.starts_with(APPROVED_RUN_PREFIX) {
        vec![descriptor()]
    } else {
        Vec::new()
    }
}

/// One saved memory as the search reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SearchMemory<'a> {
    pub scope: &'a str,
    pub scope_id: &'a str,
    pub text: &'a str,
    pub category: &'a str,
    pub created_at: &'a str,
    pub updated_at: &'a str,
}

const STOP_WORDS: &[&str] = &[
    "a", "about", "an", "and", "any", "are", "as", "at", "be", "by", "can", "do", "does", "for",
    "from", "has", "have", "how", "in", "into", "is", "it", "its", "me", "my", "of", "on", "or",
    "our", "so", "that", "the", "their", "them", "they", "this", "to", "was", "what", "with",
];

/// Lowercase word stems, without stop words: `loaders` reads as `loader`,
/// `maintained` as `maintain`.
fn words(text: &str) -> Vec<String> {
    text.split(|ch: char| !ch.is_alphanumeric())
        .map(str::to_lowercase)
        .filter(|word| word.chars().count() > 1 && !STOP_WORDS.contains(&word.as_str()))
        .map(|word| {
            for suffix in ["ing", "ed", "es", "s"] {
                if let Some(stem) = word.strip_suffix(suffix) {
                    if stem.chars().count() >= 3 {
                        return stem.to_string();
                    }
                }
            }
            word
        })
        .collect()
}

/// Equal stems, or one stem of four letters or more that starts the other
/// (`prefer` and `preference`).
fn same_word(left: &str, right: &str) -> bool {
    left == right
        || (left.len().min(right.len()) >= 4
            && (left.starts_with(right) || right.starts_with(left)))
}

fn sensitive(text: &str) -> bool {
    let options = MemoryGuardOptions {
        exclude_sensitive: true,
        protected_texts: &[],
    };
    matches!(
        check_memory_text(text, &options),
        Err(MemoryGuardError::Sensitive { .. })
    )
}

/// The memories visible to `run` that best match `query`, best first and at
/// most `limit` of them. Every query word a memory shares counts once; ties
/// go to the newest. A query with no words returns the newest memories.
pub(crate) fn search<'a>(
    run: &MemoryRun<'_>,
    settings: MemorySettings,
    memories: &[SearchMemory<'a>],
    query: &str,
    limit: usize,
) -> Vec<SearchMemory<'a>> {
    if !settings.enabled {
        return Vec::new();
    }
    let scopes = MemoryScopes::for_run(run);
    let mut query_words = words(query);
    query_words.sort();
    query_words.dedup();
    let mut scored: Vec<(usize, SearchMemory<'a>)> = memories
        .iter()
        .filter(|memory| scopes.applies(memory.scope, memory.scope_id))
        .filter(|memory| !(settings.exclude_sensitive && sensitive(memory.text)))
        .map(|memory| {
            let own = words(&format!("{} {}", memory.text, memory.category));
            let score = query_words
                .iter()
                .filter(|wanted| own.iter().any(|word| same_word(wanted, word)))
                .count();
            (score, *memory)
        })
        .filter(|(score, _)| query_words.is_empty() || *score > 0)
        .collect();
    scored.sort_by(|(left_score, left), (right_score, right)| {
        right_score
            .cmp(left_score)
            .then_with(|| right.updated_at.cmp(left.updated_at))
            .then_with(|| right.created_at.cmp(left.created_at))
            .then_with(|| left.text.cmp(right.text))
    });
    scored
        .into_iter()
        .take(limit.clamp(1, MAX_LIMIT))
        .map(|(_, memory)| memory)
        .collect()
}

/// Why a search was not answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SearchError {
    Invalid(&'static str),
    Server,
}

impl SearchError {
    fn response(self) -> (StatusCode, BrokerCallResponse) {
        match self {
            Self::Invalid(message) => (
                StatusCode::BAD_REQUEST,
                BrokerCallResponse::failure(codes::INVALID_REQUEST, message),
            ),
            Self::Server => (
                StatusCode::INTERNAL_SERVER_ERROR,
                BrokerCallResponse::failure(codes::SERVER_ERROR, "Memories are unavailable."),
            ),
        }
    }
}

/// The query and limit of a call.
fn arguments(args: &Value) -> Result<(String, usize), SearchError> {
    let query = args["query"]
        .as_str()
        .ok_or(SearchError::Invalid("query is required."))?;
    let query: String = query.trim().chars().take(MAX_QUERY_CHARS).collect();
    let limit = args["limit"]
        .as_u64()
        .map_or(DEFAULT_LIMIT, |limit| limit.min(MAX_LIMIT as u64) as usize);
    Ok((query, limit))
}

type RunRow = (String, String, String, Option<String>);

/// Counts one search of the evaluation `run_id`. False once it had
/// [`MAX_EVALUATION_SEARCHES`] answers or it is no longer the active
/// evaluation of its group, or of its agent for a personal agent
/// evaluation; nothing is counted then.
pub(crate) async fn charge_evaluation_search(
    pool: &PgPool,
    run_id: &str,
) -> Result<bool, sqlx_core::Error> {
    let state = match run_id.starts_with(RUN_PREFIX) {
        true => "cloud_agent_proactive_state",
        false => "cloud_personal_agent_state",
    };
    let charged = query(&format!(
        "UPDATE {state} SET memory_searches = memory_searches + 1 \
         WHERE active_run_id = $1 AND memory_searches < $2"
    ))
    .bind(run_id)
    .bind(MAX_EVALUATION_SEARCHES)
    .execute(pool)
    .await?;
    Ok(charged.rows_affected() == 1)
}

/// Runs one search for `run_id`: the matches, or the line that ends an
/// evaluation's searches.
async fn answer(state: &ServerState, run_id: &str, args: &Value) -> Result<Value, SearchError> {
    let (query, limit) = arguments(args)?;
    let pool: &PgPool = state.db_pool();
    if super::desktop::is_evaluation(run_id) {
        // A failed count answers nothing.
        let charged = charge_evaluation_search(pool, run_id)
            .await
            .map_err(|error| {
                eprintln!("[proactive] memory search count: {error}");
                SearchError::Server
            })?;
        if !charged {
            return Ok(json!({"memories": [], "note": NO_SEARCHES_LEFT}));
        }
    }
    let row: Option<RunRow> = query_as(
        "SELECT owner_account_id, requester_account_id, session_id, subsession_id::text \
         FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(run_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| {
        eprintln!("[proactive] memory search run: {error}");
        SearchError::Server
    })?;
    let Some((owner, requester, session_id, subsession_id)) = row else {
        return Err(SearchError::Server);
    };
    let list = crate::memory_store::list(pool, &owner)
        .await
        .map_err(|error| {
            eprintln!("[proactive] memory search list: {}", error.code);
            SearchError::Server
        })?;
    let memories: Vec<SearchMemory<'_>> = list
        .memories
        .iter()
        .map(|memory| SearchMemory {
            scope: &memory.scope,
            scope_id: &memory.scope_id,
            text: &memory.text,
            category: &memory.category,
            created_at: &memory.created_at,
            updated_at: &memory.updated_at,
        })
        .collect();
    let run = MemoryRun {
        session_id: &session_id,
        subsession_id: subsession_id.as_deref(),
        owner_request: owner == requester,
    };
    let settings = MemorySettings {
        enabled: list.settings.memory_enabled,
        exclude_sensitive: list.settings.exclude_sensitive,
    };
    let found: Vec<Value> = search(&run, settings, &memories, &query, limit)
        .into_iter()
        .map(|memory| {
            json!({
                "text": memory.text,
                "scope": memory.scope,
                "category": memory.category,
                "updatedAt": memory.updated_at,
            })
        })
        .collect();
    Ok(json!({"memories": found, "note": PRIVATE_NOTE}))
}

fn refuse(status: StatusCode, code: &str, message: &str) -> (StatusCode, BrokerCallResponse) {
    (status, BrokerCallResponse::failure(code, message))
}

/// Answers one broker call of `search_memory` for the run whose lease
/// `holder` holds, when the lease carries the tool.
pub(crate) async fn call(
    state: &ServerState,
    holder: &LeaseHolder,
    request: &BrokerCallRequest,
) -> (StatusCode, BrokerCallResponse) {
    let run_id = request.lease_id.trim();
    if request.tool.trim() != SEARCH_MEMORY_TOOL {
        return refuse(
            StatusCode::BAD_REQUEST,
            codes::UNKNOWN_TOOL,
            "Unknown memory tool.",
        );
    }
    if request.declined_by_owner {
        return refuse(
            StatusCode::BAD_REQUEST,
            codes::INVALID_REQUEST,
            "search_memory only reads and needs no approval.",
        );
    }
    let lease = match load_active_lease(state.db_pool(), run_id, holder).await {
        Ok(Some(lease)) => lease,
        Ok(None) => {
            return refuse(
                StatusCode::FORBIDDEN,
                codes::LEASE_INVALID,
                "This run no longer holds its lease.",
            )
        }
        Err(error) => {
            eprintln!("[proactive] memory search lease: {error}");
            return SearchError::Server.response();
        }
    };
    if !lease.has_tool(MEMORY_CONNECTOR_ID, SEARCH_MEMORY_TOOL) {
        return refuse(
            StatusCode::FORBIDDEN,
            codes::NOT_ON_LEASE,
            "This tool was not delivered to this run.",
        );
    }
    match answer(state, run_id, &request.args).await {
        Ok(result) => (StatusCode::OK, BrokerCallResponse::success(result)),
        Err(error) => error.response(),
    }
}

/// Answers one tool call of the Mac that holds the evaluation `run_id`, sent
/// through the digest observe route. `Ok(None)` when this claim does not hold
/// the run. A call the tool cannot take is answered with an `error` the
/// model reads.
pub(crate) async fn observe(
    state: &ServerState,
    session: &CloudSession,
    run_id: &str,
    claim_id: Uuid,
    tool: &str,
    args: &Value,
) -> Result<Option<Value>, sqlx_core::Error> {
    let executor = super::desktop::executor(session, claim_id);
    if !super::desktop::held(state.db_pool(), run_id, &session.account_id, &executor).await? {
        return Ok(None);
    }
    if tool != SEARCH_MEMORY_TOOL {
        return Ok(Some(
            json!({"error": "Only search_memory is available in this run."}),
        ));
    }
    Ok(Some(match answer(state, run_id, args).await {
        Ok(result) => result,
        Err(SearchError::Invalid(message)) => json!({"error": message}),
        Err(SearchError::Server) => json!({"error": "Memories are unavailable right now."}),
    }))
}

#[cfg(test)]
#[path = "memory_search_tests.rs"]
mod tests;

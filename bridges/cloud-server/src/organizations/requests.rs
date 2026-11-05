//! The organization a request acts in (docs/development/organization-requests.md).
//!
//! The session middleware reads the token's organization claim, compares it
//! with the `Kordi-Organization` header, and stores the result as a
//! [`RequestOrganization`] request extension. Organization-scoped routes and
//! handlers that touch content compare the content's organization with it.
//! This is the logging phase: every mismatch is logged and the request
//! continues as before.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, Method};
use axum::middleware::Next;
use axum::response::Response;
use sqlx_core::executor::Executor;
use sqlx_core::query_as::query_as;
use sqlx_core::query_scalar::query_scalar;
use sqlx_postgres::Postgres;

use crate::auth::session::SessionOrganization;
use crate::server::ServerState;

/// The request header that names the organization a client acts in.
pub const ORGANIZATION_HEADER: &str = "kordi-organization";

/// Whether the request named an organization in the header.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HeaderState {
    Present,
    Missing,
}

/// Why a request does not agree with its token's organization.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Mismatch {
    /// The header names another organization.
    Header { named: String },
    /// The token claims an organization the account no longer belongs to.
    MembershipEnded { claimed: String },
    /// An organization-scoped route got no header.
    MissingHeader,
    /// The content belongs to another organization the caller is in.
    Content { content: String },
}

impl Mismatch {
    fn describe(&self) -> String {
        match self {
            Self::Header { named } => format!("header names {named}"),
            Self::MembershipEnded { claimed } => format!("membership in {claimed} ended"),
            Self::MissingHeader => "header missing".to_string(),
            Self::Content { content } => format!("content belongs to {content}"),
        }
    }
}

/// The checked organization of one request, stored as a request extension.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestOrganization {
    pub account_id: String,
    /// The organization the request acts in.
    pub organization_id: String,
    pub personal_organization_id: String,
    pub header: HeaderState,
    /// How the token and the header disagree, if they do. Only
    /// organization-scoped routes report it.
    pub mismatch: Option<Mismatch>,
}

impl RequestOrganization {
    /// Checks the token's claim and the request header. `None` when the
    /// account has no personal organization, which only a database without
    /// migration 0162 could produce.
    pub fn resolve(
        account_id: &str,
        claim: &SessionOrganization,
        header: Option<&str>,
    ) -> Option<Self> {
        let personal = claim.personal.clone()?;
        let (organization_id, mut mismatch) = match &claim.claimed {
            Some(claimed) if claim.claim_active => (claimed.clone(), None),
            Some(claimed) => (
                personal.clone(),
                Some(Mismatch::MembershipEnded {
                    claimed: claimed.clone(),
                }),
            ),
            None => (personal.clone(), None),
        };
        let header = header.map(str::trim).filter(|value| !value.is_empty());
        let state = match header {
            None => HeaderState::Missing,
            Some(named) => {
                if named != organization_id {
                    mismatch.get_or_insert(Mismatch::Header {
                        named: named.to_string(),
                    });
                }
                HeaderState::Present
            }
        };
        if state == HeaderState::Missing && mismatch.is_none() {
            mismatch = Some(Mismatch::MissingHeader);
        }
        Some(Self {
            account_id: account_id.to_string(),
            organization_id,
            personal_organization_id: personal,
            header: state,
            mismatch,
        })
    }

    /// Stores the request organization of `claim` and `headers` on `request`.
    pub fn attach(
        request: &mut Request,
        account_id: &str,
        claim: &SessionOrganization,
        headers: &HeaderMap,
    ) {
        if let Some(organization) = Self::resolve(account_id, claim, header_value(headers)) {
            request.extensions_mut().insert(organization);
        }
    }

    /// Whether content of `content_organization` disagrees with this request.
    /// Content in an organization the caller is not a member of (outsider
    /// participation, someone else's personal content) is left to the
    /// participant rules; `caller_is_member` says which case applies.
    pub fn content_mismatch(
        &self,
        content_organization: &str,
        caller_is_member: bool,
    ) -> Option<Mismatch> {
        (content_organization != self.organization_id && caller_is_member).then(|| {
            Mismatch::Content {
                content: content_organization.to_string(),
            }
        })
    }

    /// Compares content with this request and logs a mismatch.
    /// `content_organization` `None` means the caller's personal organization.
    pub async fn check_content<'e, E>(
        &self,
        executor: E,
        route: &str,
        content_organization: Option<&str>,
    ) where
        E: Executor<'e, Database = Postgres>,
    {
        let content = content_organization.unwrap_or(&self.personal_organization_id);
        if content == self.organization_id {
            return;
        }
        let member: Result<(bool,), _> = query_as("SELECT cloud_is_organization_member($1, $2)")
            .bind(content)
            .bind(&self.account_id)
            .fetch_one(executor)
            .await;
        match member {
            Ok((member,)) => {
                if let Some(mismatch) = self.content_mismatch(content, member) {
                    self.report(route, &mismatch);
                }
            }
            Err(error) => eprintln!("[organizations] check content organization: {error}"),
        }
    }

    /// Logs `mismatch`.
    pub fn report(&self, route: &str, mismatch: &Mismatch) {
        eprintln!(
            "[organizations] organization mismatch: route={route} account={} organization={} {}",
            self.account_id,
            self.organization_id,
            mismatch.describe(),
        );
    }
}

/// The header value of a request, if it is valid text.
pub fn header_value(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(ORGANIZATION_HEADER)
        .and_then(|value| value.to_str().ok())
}

/// Reports the token or header mismatch of an organization-scoped request,
/// including a missing header.
pub fn check_scoped_request(request: &Request) {
    if let Some(organization) = request.extensions().get::<RequestOrganization>() {
        if let Some(mismatch) = &organization.mismatch {
            organization.report(request.uri().path(), mismatch);
        }
    }
}

/// Content a path parameter names, and how to read its organization.
const CONTENT_LOOKUPS: [(&str, &str); 2] = [
    (
        "agent_id",
        "SELECT organization_id FROM cloud_agent_definitions WHERE agent_id = $1",
    ),
    (
        "task_id",
        "SELECT organization_id FROM scheduled_tool_tasks WHERE task_id = $1",
    ),
];

/// Route layer for organization-scoped routes, inside the session
/// middleware: the token and header check, and for a request that changes an
/// agent or a scheduled task named in the path, the content check.
pub async fn organization_scoped(
    State(state): State<Arc<ServerState>>,
    path: Option<Path<HashMap<String, String>>>,
    request: Request,
    next: Next,
) -> Response {
    check_scoped_request(&request);
    let reads = matches!(*request.method(), Method::GET | Method::HEAD);
    if let (false, Some(Path(params)), Some(organization)) = (
        reads,
        path,
        request.extensions().get::<RequestOrganization>(),
    ) {
        for (param, lookup) in CONTENT_LOOKUPS {
            let Some(id) = params.get(param) else {
                continue;
            };
            let content: Option<Option<String>> = match query_scalar(lookup)
                .bind(id)
                .fetch_optional(state.db_pool())
                .await
            {
                Ok(content) => content,
                Err(error) => {
                    eprintln!("[organizations] read content organization: {error}");
                    continue;
                }
            };
            if let Some(content) = content {
                let route = request.uri().path();
                organization
                    .check_content(state.db_pool(), route, content.as_deref())
                    .await;
            }
        }
    }
    next.run(request).await
}

/// New content should be created in the request organization: the one it
/// names, or the owner's personal one when it names nothing.
pub async fn check_new_content(
    organization: Option<&RequestOrganization>,
    pool: &sqlx_postgres::PgPool,
    route: &str,
    named: Option<&str>,
) {
    if let Some(organization) = organization {
        let named = super::selection::requested(named);
        organization.check_content(pool, route, named).await;
    }
}

/// The organization facts of the session row `token_id`, for callers that
/// did not read them with the session (the web cookie path).
pub async fn load_for_session<'e, E>(
    executor: E,
    token_id: &str,
) -> Result<Option<SessionOrganization>, sqlx_core::Error>
where
    E: Executor<'e, Database = Postgres>,
{
    let row: Option<(Option<String>, Option<String>, bool)> = query_as(&format!(
        "SELECT {} FROM cloud_refresh_tokens token WHERE token.token_id = $1",
        crate::auth::session::SESSION_ORGANIZATION_COLUMNS
    ))
    .bind(token_id)
    .fetch_optional(executor)
    .await?;
    Ok(
        row.map(|(claimed, personal, claim_active)| SessionOrganization {
            claimed,
            personal,
            claim_active,
        }),
    )
}

#[cfg(test)]
mod tests;

//! Socket tickets and the init grant.
//!
//! Tickets follow the chat realtime scheme (`chat_sync/realtime/ticket.rs`):
//! 32 random bytes behind a prefix, stored as a SHA-256 hash, single use,
//! bound to the issuing session and to the browser origin when there is one,
//! and short-lived. They are kept in their own table and are also bound to
//! one canonical document.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Duration, Utc};
use rand::RngCore;
use sha2::{Digest, Sha256};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

pub(crate) const TICKET_PREFIX: &str = "kordi_dc_";
pub(crate) const TICKET_LIFETIME_SECONDS: i64 = 60;
pub(crate) const INIT_GRANT_SECONDS: i64 = 30;

#[derive(Debug)]
pub(crate) enum TicketError {
    Database(sqlx_core::Error),
    InvalidTicket,
    OriginNotAllowed,
}

impl From<sqlx_core::Error> for TicketError {
    fn from(error: sqlx_core::Error) -> Self {
        Self::Database(error)
    }
}

/// What a consumed ticket proves.
#[derive(Debug, Clone)]
pub(crate) struct ConsumedTicket {
    pub attachment_id: String,
    pub requested_attachment_id: String,
    pub account_id: String,
    pub device_id: String,
    pub session_token_id: String,
    pub allowed_origin: Option<String>,
}

/// The browser origins sockets may come from; the chat realtime allowlist.
fn allowed_origins() -> Vec<String> {
    std::env::var("KORDI_CHAT_REALTIME_ALLOWED_ORIGINS")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn origin_matches(origin: &str, allowed: &str) -> bool {
    if origin == allowed {
        return true;
    }
    let (Ok(origin), Ok(allowed)) = (url::Url::parse(origin), url::Url::parse(allowed)) else {
        return false;
    };
    // A bare `http://127.0.0.1` entry allows any loopback port (desktop dev).
    allowed.scheme() == "http"
        && allowed.host_str() == Some("127.0.0.1")
        && allowed.port().is_none()
        && origin.scheme() == allowed.scheme()
        && origin.host_str() == allowed.host_str()
}

/// The origin a ticket is bound to: `None` for native clients that send no
/// `Origin`, the origin itself when it is allowlisted.
pub(crate) fn bind_origin(
    origin: Option<&str>,
    allowlist: &[String],
) -> Result<Option<String>, TicketError> {
    let Some(origin) = origin.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if origin == "null"
        || !allowlist
            .iter()
            .any(|allowed| origin_matches(origin, allowed))
    {
        return Err(TicketError::OriginNotAllowed);
    }
    Ok(Some(origin.to_string()))
}

pub(crate) fn random_ticket() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("{TICKET_PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes))
}

pub(crate) fn ticket_hash(plaintext: &str) -> Result<String, TicketError> {
    let encoded = plaintext
        .strip_prefix(TICKET_PREFIX)
        .ok_or(TicketError::InvalidTicket)?;
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| TicketError::InvalidTicket)?;
    if decoded.len() != 32 {
        return Err(TicketError::InvalidTicket);
    }
    Ok(hex::encode(Sha256::digest(plaintext.as_bytes())))
}

pub(crate) struct TicketRequest<'a> {
    pub attachment_id: &'a str,
    pub requested_attachment_id: &'a str,
    pub account_id: &'a str,
    pub device_id: &'a str,
    pub session_token_id: &'a str,
    pub origin: Option<&'a str>,
}

/// Issues a ticket for a live session; `InvalidTicket` when the session or
/// its device is gone.
pub(crate) async fn issue_ticket(
    pool: &PgPool,
    request: TicketRequest<'_>,
) -> Result<String, TicketError> {
    let allowed_origin = bind_origin(request.origin, &allowed_origins())?;
    let plaintext = random_ticket();
    let expires_at = Utc::now() + Duration::seconds(TICKET_LIFETIME_SECONDS);
    let inserted = query(
        "INSERT INTO cloud_document_collab_tickets \
         (ticket_hash, attachment_id, requested_attachment_id, account_id, device_id, \
          session_token_id, allowed_origin, expires_at) \
         SELECT $1, $2, $3, $4, $5, token.token_id, $7, $8 \
         FROM cloud_devices device \
         JOIN cloud_refresh_tokens token \
           ON token.device_id = device.device_id AND token.account_id = device.account_id \
         WHERE device.device_id = $5 AND device.account_id = $4 AND device.revoked_at IS NULL \
           AND token.token_id = $6 AND token.revoked_at IS NULL",
    )
    .bind(ticket_hash(&plaintext)?)
    .bind(request.attachment_id)
    .bind(request.requested_attachment_id)
    .bind(request.account_id)
    .bind(request.device_id)
    .bind(request.session_token_id)
    .bind(allowed_origin)
    .bind(expires_at)
    .execute(pool)
    .await?
    .rows_affected();
    if inserted != 1 {
        return Err(TicketError::InvalidTicket);
    }
    // Expired tickets are never usable; drop old ones as new ones are issued.
    let _ = query(
        "DELETE FROM cloud_document_collab_tickets WHERE expires_at < now() - interval '1 hour'",
    )
    .execute(pool)
    .await;
    Ok(plaintext)
}

type TicketRow = (String, String, String, String, String, Option<String>);

/// Consumes a ticket once, before it expires, while its device is active.
pub(crate) async fn consume_ticket(
    pool: &PgPool,
    plaintext: &str,
) -> Result<ConsumedTicket, TicketError> {
    let hash = ticket_hash(plaintext)?;
    let row: Option<TicketRow> = query_as(
        "UPDATE cloud_document_collab_tickets AS ticket SET consumed_at = now() \
         FROM cloud_devices AS device \
         WHERE ticket.ticket_hash = $1 AND ticket.consumed_at IS NULL \
           AND ticket.expires_at > now() \
           AND device.device_id = ticket.device_id AND device.account_id = ticket.account_id \
           AND device.revoked_at IS NULL \
         RETURNING ticket.attachment_id, ticket.requested_attachment_id, ticket.account_id, \
                   ticket.device_id, ticket.session_token_id, ticket.allowed_origin",
    )
    .bind(hash)
    .fetch_optional(pool)
    .await?;
    let (attachment_id, requested_attachment_id, account_id, device_id, session_token_id, origin) =
        row.ok_or(TicketError::InvalidTicket)?;
    Ok(ConsumedTicket {
        attachment_id,
        requested_attachment_id,
        account_id,
        device_id,
        session_token_id,
        allowed_origin: origin,
    })
}

/// The room's init state as the grant decision needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InitState {
    pub initialized: bool,
    pub granted_to: Option<String>,
    pub grant_expires_at: Option<DateTime<Utc>>,
}

/// Whether `caller` gets (or keeps) the job of seeding the room: only while
/// the room is not initialized, and only when nobody else holds an unexpired
/// grant. The holder asking again keeps it.
pub(crate) fn grants_init(state: &InitState, caller: &str, now: DateTime<Utc>) -> bool {
    if state.initialized {
        return false;
    }
    match (&state.granted_to, state.grant_expires_at) {
        (Some(holder), Some(expires_at)) if expires_at > now => holder == caller,
        _ => true,
    }
}

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Utc};
use rand::RngCore;
use sha2::{Digest, Sha256};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

const TICKET_PREFIX: &str = "kordi_rt_";
const TICKET_LIFETIME_SECONDS: i64 = 30;

#[derive(Debug)]
pub enum TicketError {
    Database(sqlx_core::Error),
    InvalidTicket,
    OriginNotAllowed,
}

impl From<sqlx_core::Error> for TicketError {
    fn from(error: sqlx_core::Error) -> Self {
        Self::Database(error)
    }
}

pub struct IssuedRealtimeTicket {
    pub plaintext: String,
    pub expires_at: DateTime<Utc>,
}

pub(super) struct ConsumedRealtimeTicket {
    pub(super) account_id: String,
    pub(super) device_id: String,
    pub(super) allowed_origin: Option<String>,
}

fn allowed_origins() -> Vec<String> {
    std::env::var("KORDI_CHAT_REALTIME_ALLOWED_ORIGINS")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn bind_origin(origin: Option<&str>, allowlist: &[String]) -> Result<Option<String>, TicketError> {
    let Some(origin) = origin.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if origin == "null" || !allowlist.iter().any(|allowed| allowed == origin) {
        return Err(TicketError::OriginNotAllowed);
    }
    Ok(Some(origin.to_string()))
}

fn random_ticket() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("{TICKET_PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes))
}

fn ticket_hash(plaintext: &str) -> Result<String, TicketError> {
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

pub async fn issue_ticket(
    pool: &PgPool,
    account_id: &str,
    device_id: &str,
    origin: Option<&str>,
) -> Result<IssuedRealtimeTicket, TicketError> {
    if account_id.trim().is_empty() || device_id.trim().is_empty() {
        return Err(TicketError::InvalidTicket);
    }
    let allowed_origin = bind_origin(origin, &allowed_origins())?;
    let plaintext = random_ticket();
    let hash = ticket_hash(&plaintext)?;
    let expires_at = Utc::now() + chrono::Duration::seconds(TICKET_LIFETIME_SECONDS);
    query(
        "INSERT INTO cloud_chat_realtime_tickets \
         (ticket_hash, account_id, device_id, allowed_origin, expires_at) \
         SELECT $1, $2, $3, $4, $5 \
         FROM cloud_devices \
         WHERE device_id = $3 AND account_id = $2 AND revoked_at IS NULL",
    )
    .bind(hash)
    .bind(account_id)
    .bind(device_id)
    .bind(allowed_origin)
    .bind(expires_at)
    .execute(pool)
    .await?
    .rows_affected()
    .eq(&1)
    .then_some(())
    .ok_or(TicketError::InvalidTicket)?;
    Ok(IssuedRealtimeTicket {
        plaintext,
        expires_at,
    })
}

pub(super) async fn consume_ticket(
    pool: &PgPool,
    plaintext: &str,
) -> Result<ConsumedRealtimeTicket, TicketError> {
    let hash = ticket_hash(plaintext)?;
    let row: Option<(String, String, Option<String>)> = query_as(
        "UPDATE cloud_chat_realtime_tickets AS ticket \
         SET consumed_at = now() \
         FROM cloud_devices AS device \
         WHERE ticket.ticket_hash = $1 \
           AND ticket.consumed_at IS NULL \
           AND ticket.expires_at > now() \
           AND device.device_id = ticket.device_id \
           AND device.account_id = ticket.account_id \
           AND device.revoked_at IS NULL \
         RETURNING ticket.account_id, ticket.device_id, ticket.allowed_origin",
    )
    .bind(hash)
    .fetch_optional(pool)
    .await?;
    row.map(
        |(account_id, device_id, allowed_origin)| ConsumedRealtimeTicket {
            account_id,
            device_id,
            allowed_origin,
        },
    )
    .ok_or(TicketError::InvalidTicket)
}

#[cfg(test)]
mod tests {
    use super::{bind_origin, random_ticket, ticket_hash, TicketError, TICKET_PREFIX};

    #[test]
    fn tickets_are_opaque_random_and_hash_stably() {
        let first = random_ticket();
        let second = random_ticket();
        assert!(first.starts_with(TICKET_PREFIX));
        assert_ne!(first, second);
        assert_eq!(ticket_hash(&first).unwrap(), ticket_hash(&first).unwrap());
        assert_ne!(ticket_hash(&first).unwrap(), ticket_hash(&second).unwrap());
        assert!(!ticket_hash(&first).unwrap().contains(&first));
        assert!(matches!(
            ticket_hash("kordi_rt_invalid"),
            Err(TicketError::InvalidTicket)
        ));
    }

    #[test]
    fn browser_origins_are_exactly_allowlisted_and_bound() {
        let allowed = vec![
            "https://coordinar.io".to_string(),
            "http://localhost:1420".to_string(),
        ];
        assert_eq!(
            bind_origin(Some("https://coordinar.io"), &allowed).unwrap(),
            Some("https://coordinar.io".to_string())
        );
        assert!(matches!(
            bind_origin(Some("https://coordinar.io.evil.example"), &allowed),
            Err(TicketError::OriginNotAllowed)
        ));
        assert!(matches!(
            bind_origin(Some("null"), &allowed),
            Err(TicketError::OriginNotAllowed)
        ));
        assert_eq!(bind_origin(None, &allowed).unwrap(), None);
    }
}

use sqlx_postgres::PgPool;

use super::ticket::ConsumedRealtimeTicket;
use crate::auth::admission::AdmissionPolicy;
use crate::auth::session::{device_is_active, session_is_active};

/// Whether the socket opened with `ticket` may keep streaming: the issuing
/// session is still signed in and its device authorization is active.
pub(super) async fn connection_is_active(
    pool: &PgPool,
    ticket: &ConsumedRealtimeTicket,
    policy: &AdmissionPolicy,
) -> bool {
    if policy
        .authorize_account(pool, &ticket.account_id)
        .await
        .is_err()
    {
        return false;
    }
    let result = match ticket.session_token_id.as_deref() {
        Some(token_id) => {
            session_is_active(pool, &ticket.account_id, &ticket.device_id, token_id).await
        }
        None => device_is_active(pool, &ticket.account_id, &ticket.device_id).await,
    };
    match result {
        Ok(active) => active,
        Err(error) => {
            eprintln!("[chat-realtime] revalidate session: {error}");
            false
        }
    }
}

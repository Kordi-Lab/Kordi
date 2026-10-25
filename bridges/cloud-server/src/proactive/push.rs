//! The push that tells the owner an agent can help. Evaluations finish on
//! the runner's completion path, which holds only the pool, so the worker
//! installs the server's push service here at start. Without one (local
//! stacks) the push is skipped, as every other push is.

use std::sync::OnceLock;

use sqlx_postgres::PgPool;

use crate::notifications::{ProactiveOfferPush, PushNotificationService};

static SERVICE: OnceLock<PushNotificationService> = OnceLock::new();

const OFFER_LIMIT: usize = 120;

pub(super) fn install(service: Option<&PushNotificationService>) {
    if let Some(service) = service {
        let _ = SERVICE.set(service.clone());
    }
}

/// "Can help in <group>: <offer>", the offer cut to about 120 characters.
pub(super) fn body(conversation_title: Option<&str>, offer: &str) -> String {
    let group = conversation_title
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .unwrap_or("a group");
    let offer = offer.split_whitespace().collect::<Vec<_>>().join(" ");
    let offer = match offer.chars().count() > OFFER_LIMIT {
        true => {
            let cut: String = offer.chars().take(OFFER_LIMIT - 1).collect();
            format!("{}…", cut.trim_end())
        }
        false => offer,
    };
    format!("Can help in {group}: {offer}")
}

/// Sends the push for a new proposal in the background. Best effort.
pub(super) fn offer(pool: &PgPool, proposal_id: &str) {
    let Some(service) = SERVICE.get().cloned() else {
        return;
    };
    let pool = pool.clone();
    let proposal_id = proposal_id.to_string();
    tokio::spawn(async move {
        let proposal = match super::proposal::load(&pool, &proposal_id).await {
            Ok(Some(proposal)) if proposal.status == "pending" => proposal,
            Ok(_) => return,
            Err(error) => {
                eprintln!("[proactive] Could not load {proposal_id} for its push: {error}");
                return;
            }
        };
        let body = body(proposal.conversation_title.as_deref(), &proposal.offer);
        let conversation_id = proposal.conversation_id.to_string();
        service
            .send_proactive_offer(
                &pool,
                &ProactiveOfferPush {
                    account_id: &proposal.owner_account_id,
                    proposal_id: &proposal.proposal_id,
                    conversation_id: &conversation_id,
                    title: &proposal.agent_name,
                    body: &body,
                },
            )
            .await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_body_names_the_group_and_cuts_the_offer() {
        assert_eq!(
            body(Some("Launch"), "Riya, I can look at\nthe failing step."),
            "Can help in Launch: Riya, I can look at the failing step."
        );
        assert_eq!(body(Some("  "), "Sure."), "Can help in a group: Sure.");
        let long = body(None, &"word ".repeat(60));
        let offer = long.strip_prefix("Can help in a group: ").unwrap();
        assert!(offer.chars().count() <= OFFER_LIMIT);
        assert!(offer.ends_with('…'));
    }
}

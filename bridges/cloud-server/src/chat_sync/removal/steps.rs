//! The digests and quotes steps of a removal job.

use super::*;

/// The most messages one attempt of the quotes step examines.
const QUOTE_MESSAGES_PER_ATTEMPT: i64 = 1_000;
const QUOTE_PAGE: i64 = 200;
const DIGEST_BACKFILL_PAGE: i64 = 200;

pub(super) async fn digests(pool: &PgPool, job: &mut Job) -> StepOutcome {
    let scope = match (job.reason.as_str(), &job.account_id, job.conversation_id) {
        ("message_deleted" | "message_edited", _, Some(conversation_id)) => {
            crate::digest::ScrubScope::Conversation(conversation_id)
        }
        ("message_hidden", Some(account_id), _) => crate::digest::ScrubScope::Account(account_id),
        ("backfill", _, _) => {
            let after = job.progress["digestAfterAccount"]
                .as_str()
                .map(ToString::to_string);
            return match crate::digest::backfill(pool, after.as_deref(), DIGEST_BACKFILL_PAGE).await
            {
                Ok((_, Some(next))) => {
                    job.progress["digestAfterAccount"] = Value::String(next);
                    StepOutcome::More
                }
                Ok((_, None)) => StepOutcome::Done,
                Err(error) => StepOutcome::Failed(database_error(error)),
            };
        }
        // A hide by an account that no longer exists leaves no digest.
        _ => return StepOutcome::Done,
    };
    let Some(message_id) = job.message_id else {
        return StepOutcome::Done;
    };
    match crate::digest::scrub_sources(pool, scope, &[message_id.to_string()]).await {
        Ok(_) => StepOutcome::Done,
        Err(error) => StepOutcome::Failed(database_error(error)),
    }
}

pub(super) async fn quotes(pool: &PgPool, job: &mut Job) -> StepOutcome {
    let (Some(conversation_id), Some(message_id)) = (job.conversation_id, job.message_id) else {
        return StepOutcome::Done;
    };
    let source: Result<Option<(i64,)>, _> =
        query_as("SELECT conversation_sequence FROM cloud_chat_messages WHERE message_id = $1")
            .bind(message_id)
            .fetch_optional(pool)
            .await;
    let source_sequence = match source {
        Ok(Some((sequence,))) => sequence,
        // The conversation itself is gone, and its replies with it.
        Ok(None) => return StepOutcome::Done,
        Err(error) => return StepOutcome::Failed(database_error(error)),
    };
    let identifiers = match job.exclusive_identifiers(pool).await {
        Ok(identifiers) => identifiers,
        Err(error) => return StepOutcome::Failed(database_error(error)),
    };
    let mut after = job.progress["quoteAfterSequence"].as_i64().unwrap_or(0);
    let mut examined = 0;
    while examined < QUOTE_MESSAGES_PER_ATTEMPT {
        let page = match store::scrub_quote_page(
            pool,
            conversation_id,
            source_sequence,
            &identifiers,
            after,
            QUOTE_PAGE,
        )
        .await
        {
            Ok(page) => page,
            Err(error) => return StepOutcome::Failed(database_error(error)),
        };
        after = page.last_sequence;
        job.progress["quoteAfterSequence"] = Value::from(after);
        if page.finished {
            return StepOutcome::Done;
        }
        examined += QUOTE_PAGE;
    }
    StepOutcome::More
}

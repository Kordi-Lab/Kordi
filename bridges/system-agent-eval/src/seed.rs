//! Writes a fixture conversation into the disposable database through the
//! server's own stores: accounts, the group, its history, and its card.

use std::collections::BTreeMap;

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use kordi_cloud_server::chat_sync::models::SendMessageRequest;
use kordi_cloud_server::plan_cards::models::{
    PlanCardOption, PlanCardParticipantInput, PlanCardProposeArgs, PlanCardRsvp, PlanCardState,
};
use kordi_cloud_server::plan_cards::store;
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::fixture::{CardAction, Conversation, Message, SeedCard};

/// How long before the replay a seeded card last changed: after every
/// history message and before every turn message.
pub const SEEDED_CARD_MINUTES_AGO: i64 = 30;

/// A fixture conversation as it exists in the database.
pub struct Seeded {
    pub conversation_id: Uuid,
    pub session_id: String,
    /// Member key to (account id, display name).
    pub members: BTreeMap<String, (String, String)>,
    pub system_account_id: String,
    /// The card the fixture started with.
    pub seeded_event_id: Option<String>,
}

impl Seeded {
    pub fn account(&self, key: &str) -> Result<&str> {
        if key == "system" {
            return Ok(&self.system_account_id);
        }
        self.members
            .get(key)
            .map(|(account, _)| account.as_str())
            .ok_or_else(|| anyhow!("unknown member {key}"))
    }

    pub fn key_of(&self, account_id: &str) -> Option<&str> {
        self.members
            .iter()
            .find(|(_, (account, _))| account == account_id)
            .map(|(key, _)| key.as_str())
    }
}

pub async fn conversation(
    pool: &PgPool,
    system_account_id: &str,
    fixture: &Conversation,
) -> Result<Seeded> {
    let suffix = Uuid::new_v4().simple().to_string()[..10].to_string();
    let mut members = BTreeMap::new();
    for member in &fixture.members {
        let account_id = format!("acct_eval_{}_{suffix}", member.key);
        query(
            "INSERT INTO cloud_accounts (account_id, display_name, primary_email, created_at,
                 updated_at, avatar_source, avatar_style, avatar_seed, avatar_renderer_version,
                 avatar_version, avatar_updated_at, avatar_url)
             VALUES ($1, $2, $3, $4, $4, 'generated', 'lorelei', $1, 'eval', 1, $4, $5)",
        )
        .bind(&account_id)
        .bind(&member.name)
        .bind(format!("{}.{suffix}@example.test", member.key))
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(kordi_cloud_server::avatars::generated_avatar_marker(
            "lorelei",
            &account_id,
            1,
        ))
        .execute(pool)
        .await
        .context("seeding an account")?;
        if let Some(timezone) = &member.timezone {
            query("INSERT INTO cloud_account_digests (account_id, timezone) VALUES ($1, $2)")
                .bind(&account_id)
                .bind(timezone)
                .execute(pool)
                .await?;
        }
        members.insert(member.key.clone(), (account_id, member.name.clone()));
    }
    let owner = &members[&fixture.members[0].key].0;
    let conversation_id = Uuid::new_v4();
    let session_id = format!("session:eval:{conversation_id}");
    query(
        "INSERT INTO cloud_chat_conversations (conversation_id, kind, shared_title,
             created_by_account_id, client_operation_id, creation_fingerprint, legacy_session_id)
         VALUES ($1, 'group', $2, $3, $4, 'system-agent-eval', $5)",
    )
    .bind(conversation_id)
    .bind(&fixture.title)
    .bind(owner)
    .bind(Uuid::new_v4())
    .bind(&session_id)
    .execute(pool)
    .await
    .context("seeding the conversation")?;
    for (index, member) in fixture.members.iter().enumerate() {
        query(
            "INSERT INTO cloud_chat_conversation_members (conversation_id, account_id, role)
             VALUES ($1, $2, $3)",
        )
        .bind(conversation_id)
        .bind(&members[&member.key].0)
        .bind(if index == 0 { "owner" } else { "member" })
        .execute(pool)
        .await?;
    }
    kordi_cloud_server::system_agent::membership::join_conversation(
        pool,
        system_account_id,
        conversation_id,
    )
    .await
    .context("adding the System agent")?;
    let mut seeded = Seeded {
        conversation_id,
        session_id,
        members,
        system_account_id: system_account_id.to_string(),
        seeded_event_id: None,
    };
    for message in &fixture.history {
        post(pool, &seeded, message).await?;
    }
    if let Some(card) = &fixture.card {
        seeded.seeded_event_id = Some(seed_card(pool, &seeded, card).await?);
    }
    // History is context the System agent has already read; only a turn's
    // messages are new to it.
    query(
        "INSERT INTO cloud_pip_conversation_state (conversation_id, seen_sequence,
             context_start_sequence)
         SELECT conversation_id, latest_message_sequence, 0 FROM cloud_chat_conversations
         WHERE conversation_id = $1
         ON CONFLICT (conversation_id) DO UPDATE
         SET seen_sequence = EXCLUDED.seen_sequence, context_start_sequence = 0",
    )
    .bind(conversation_id)
    .execute(pool)
    .await?;
    if let (Some(card), Some(event_id)) = (&fixture.card, &seeded.seeded_event_id) {
        let row = store::load(pool, event_id).await?.context("seeded card")?;
        let mut fired = json!({ format!("card_seen:{event_id}"): row.revision });
        for reminder in &card.reminders_sent {
            fired[format!("{reminder}:{event_id}")] = json!(true);
        }
        query(
            "UPDATE cloud_pip_conversation_state SET hooks_fired = $2 WHERE conversation_id = $1",
        )
        .bind(conversation_id)
        .bind(fired)
        .execute(pool)
        .await?;
    }
    Ok(seeded)
}

/// The text block a client sends, with its mentions in the cloud envelope.
fn text_block(seeded: &Seeded, message: &Message) -> Result<String> {
    if message.mentions.is_empty() {
        return Ok(message.text.clone());
    }
    let mut mentions = Vec::new();
    for mention in &message.mentions {
        let value = if mention == "system" {
            json!({"label": "System", "targetKind": "agent",
                "targetIdentityId": seeded.system_account_id})
        } else if let Some(key) = mention.strip_prefix("agent:") {
            let (account, name) = &seeded.members[key];
            let handle: String = name.chars().filter(|c| c.is_alphanumeric()).collect();
            json!({"label": format!("{handle}Agent"), "targetKind": "agent",
                "targetIdentityId": format!("agent:cloud-agent:{account}")})
        } else {
            let (account, name) = &seeded.members[mention.as_str()];
            json!({"label": name, "targetKind": "person", "targetIdentityId": account})
        };
        mentions.push(value);
    }
    let envelope = json!({"schemaVersion": 1, "kind": "message", "text": message.text,
        "mentions": mentions});
    Ok(format!(
        "kordi-cloud-message:{}",
        URL_SAFE_NO_PAD.encode(envelope.to_string())
    ))
}

/// Posts one message as its sender, dated `minutes_ago` before now.
pub async fn post(pool: &PgPool, seeded: &Seeded, message: &Message) -> Result<()> {
    let request = SendMessageRequest {
        client_message_id: Uuid::new_v4(),
        kind: "text".to_string(),
        content: json!({"schema": 1, "blocks": [{"type": "text", "text": text_block(seeded, message)?}],
            "legacy_attachments": []}),
        reply_to_message_id: None,
        attachment_ids: Vec::new(),
    };
    let sender = seeded.account(&message.from)?;
    let outcome = kordi_cloud_server::chat_sync::store::send_message(
        pool,
        sender,
        seeded.conversation_id,
        request,
    )
    .await
    .map_err(|error| anyhow!("posting a fixture message: {error}"))?;
    query(
        "UPDATE cloud_chat_messages SET created_at = now() - make_interval(mins => $2)
         WHERE message_id = $1",
    )
    .bind(outcome.value.id)
    .bind(message.minutes_ago as i32)
    .execute(pool)
    .await?;
    Ok(())
}

fn state(value: &str) -> Result<PlanCardState> {
    Ok(match value {
        "polling" => PlanCardState::Polling,
        "awaitingConfirmation" | "confirmed" => PlanCardState::AwaitingConfirmation,
        other => bail!("a seeded card cannot start as {other}"),
    })
}

async fn seed_card(pool: &PgPool, seeded: &Seeded, card: &SeedCard) -> Result<String> {
    let organizer = seeded.account(&card.organizer)?.to_string();
    let participants = seeded
        .members
        .iter()
        .map(|(_, (account, name))| PlanCardParticipantInput {
            account_id: account.clone(),
            display_name: name.clone(),
            organizer: *account == organizer,
        })
        .collect();
    let options = card
        .options
        .iter()
        .enumerate()
        .map(|(index, option)| PlanCardOption {
            id: format!("opt_{}", index + 1),
            label: option.label.clone(),
            start_at: option.start_at.clone(),
            location: option.location.clone(),
            ..PlanCardOption::default()
        })
        .collect();
    let args = PlanCardProposeArgs {
        conversation_id: seeded.conversation_id,
        existing_event_id: None,
        existing_revision: None,
        title: card.title.clone(),
        start_at: card.start_at.clone(),
        end_at: card.end_at.clone(),
        location: card.location.clone(),
        state: state(&card.state)?,
        unresolved_fields: Vec::new(),
        participants,
        source_message_ids: Vec::new(),
        options,
    };
    let row = store::propose(pool, &organizer, args)
        .await
        .map_err(|error| anyhow!("seeding the card: {error}"))?;
    if card.state == "confirmed" {
        store::confirm(pool, &row.event_id, row.revision, &organizer, None, None)
            .await
            .map_err(|error| anyhow!("confirming the seeded card: {error}"))?;
    }
    for (key, option) in &card.votes {
        vote(pool, seeded, &row.event_id, key, *option).await?;
    }
    for (key, answer) in &card.rsvps {
        rsvp(pool, seeded, &row.event_id, key, answer).await?;
    }
    // The card predates the turn's messages and follows the history, so a
    // turn's message counts as a newer instruction than the card.
    query(&format!(
        "UPDATE cloud_plan_cards SET updated_at = now() - interval '{SEEDED_CARD_MINUTES_AGO} minutes'
         WHERE event_id = $1"
    ))
    .bind(&row.event_id)
    .execute(pool)
    .await?;
    Ok(row.event_id)
}

async fn vote(
    pool: &PgPool,
    seeded: &Seeded,
    event_id: &str,
    key: &str,
    option: usize,
) -> Result<()> {
    store::vote(
        pool,
        event_id,
        seeded.account(key)?,
        &format!("opt_{}", option + 1),
    )
    .await
    .map_err(|error| anyhow!("fixture vote: {error}"))?;
    Ok(())
}

async fn rsvp(
    pool: &PgPool,
    seeded: &Seeded,
    event_id: &str,
    key: &str,
    answer: &str,
) -> Result<()> {
    let answer = PlanCardRsvp::from_db_str(answer).context("rsvp must be yes or no")?;
    store::rsvp(pool, event_id, seeded.account(key)?, answer, None)
        .await
        .map_err(|error| anyhow!("fixture rsvp: {error}"))?;
    Ok(())
}

/// A member acting on the card itself, dated far enough back that the sweep's
/// quiet period has passed.
pub async fn card_action(pool: &PgPool, seeded: &Seeded, action: &CardAction) -> Result<()> {
    let event_id = latest_card(pool, seeded.conversation_id)
        .await?
        .context("a card action needs a card")?;
    match action {
        CardAction::Vote { by, option } => vote(pool, seeded, &event_id, by, *option).await?,
        CardAction::Rsvp { by, rsvp: answer } => rsvp(pool, seeded, &event_id, by, answer).await?,
    }
    query(
        "UPDATE cloud_plan_cards SET updated_at = now() - interval '2 minutes' WHERE event_id = $1",
    )
    .bind(&event_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// The conversation's most recently changed card, in any state.
pub async fn latest_card(pool: &PgPool, conversation_id: Uuid) -> Result<Option<String>> {
    let row: Option<(String,)> = sqlx_core::query_as::query_as(
        "SELECT event_id FROM cloud_plan_cards WHERE conversation_id = $1
         ORDER BY updated_at DESC LIMIT 1",
    )
    .bind(conversation_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(event_id,)| event_id))
}

/// Takes the System agent out of a finished fixture so later sweeps never
/// pick it up again.
pub async fn retire(pool: &PgPool, seeded: &Seeded) -> Result<()> {
    query(
        "UPDATE cloud_chat_conversation_members SET membership_state = 'left', left_at = now()
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(seeded.conversation_id)
    .bind(&seeded.system_account_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Decoded text of the System agent's messages after `after_sequence`, and how
/// many card-only messages it posted.
pub async fn system_messages(
    pool: &PgPool,
    seeded: &Seeded,
    after_sequence: i64,
) -> Result<(Vec<String>, usize)> {
    let rows: Vec<(Value,)> = sqlx_core::query_as::query_as(
        "SELECT content FROM cloud_chat_messages
         WHERE conversation_id = $1 AND sender_account_id = $2 AND conversation_sequence > $3
         ORDER BY conversation_sequence",
    )
    .bind(seeded.conversation_id)
    .bind(&seeded.system_account_id)
    .bind(after_sequence)
    .fetch_all(pool)
    .await?;
    let mut texts = Vec::new();
    let mut cards = 0;
    for (content,) in rows {
        let blocks = content["blocks"].as_array().cloned().unwrap_or_default();
        let text: Vec<String> = blocks
            .iter()
            .filter(|block| block["type"] == "text")
            .filter_map(|block| block["text"].as_str().map(decode_text))
            .collect();
        if text.is_empty() {
            cards += 1;
        } else {
            texts.push(text.join(" "));
        }
    }
    Ok((texts, cards))
}

fn decode_text(text: &str) -> String {
    let Some(encoded) = text.strip_prefix("kordi-cloud-message:") else {
        return text.to_string();
    };
    URL_SAFE_NO_PAD
        .decode(encoded.trim_end_matches('='))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value["text"].as_str().map(str::to_string))
        .unwrap_or_default()
}

pub async fn latest_sequence(pool: &PgPool, conversation_id: Uuid) -> Result<i64> {
    let (sequence,): (i64,) = sqlx_core::query_as::query_as(
        "SELECT latest_message_sequence FROM cloud_chat_conversations WHERE conversation_id = $1",
    )
    .bind(conversation_id)
    .fetch_one(pool)
    .await?;
    Ok(sequence)
}

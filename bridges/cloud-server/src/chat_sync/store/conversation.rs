use super::support::*;
use super::*;

const LEGACY_DEFAULT_SELF_AGENT_SESSION_ID: &str = "session:self-agent:default";
const DIRECT_PERSON_SESSION_PREFIX: &str = "session:direct-person:";
const DIRECT_AGENT_SESSION_PREFIX: &str = "session:direct-agent:";
const DIRECT_SYSTEM_AGENT_SESSION_PREFIX: &str = "session:direct-system-agent:";

fn account_scoped_client_session_id(
    account_id: &str,
    kind: ConversationKind,
    members: &[String],
    session_id: String,
) -> Result<String, StoreError> {
    if session_id != LEGACY_DEFAULT_SELF_AGENT_SESSION_ID {
        return Ok(session_id);
    }
    if kind != ConversationKind::Ai || members.len() != 1 || members[0] != account_id {
        return Err(StoreError::InvalidInput(
            "default self-agent session must belong to one account",
        ));
    }
    Ok(format!("session:self-agent:{account_id}:default"))
}

fn fork_session_kind_allowed(is_registered_fork: bool, kind: ConversationKind) -> bool {
    !is_registered_fork || kind == ConversationKind::Ai
}

fn normalized_direct_session_id(
    session_id: String,
    members: &[String],
    trusted_support_owner: Option<&str>,
) -> Result<String, StoreError> {
    if session_id.starts_with(DIRECT_PERSON_SESSION_PREFIX) {
        return Ok(format!(
            "{DIRECT_PERSON_SESSION_PREFIX}{}:{}",
            members[0], members[1]
        ));
    }
    if session_id.starts_with(DIRECT_AGENT_SESSION_PREFIX)
        || (session_id.starts_with(DIRECT_SYSTEM_AGENT_SESSION_PREFIX)
            && trusted_support_owner.is_some())
    {
        return Ok(session_id);
    }
    Err(StoreError::InvalidInput(
        "direct conversation session id is invalid",
    ))
}

pub async fn create_conversation(
    pool: &PgPool,
    account_id: &str,
    request: CreateConversationRequest,
) -> Result<InsertOutcome<ConversationSnapshot>, StoreError> {
    create_conversation_with_trusted_peer(pool, account_id, request, None).await
}

pub async fn create_conversation_with_trusted_peer(
    pool: &PgPool,
    account_id: &str,
    request: CreateConversationRequest,
    trusted_peer_account_id: Option<&str>,
) -> Result<InsertOutcome<ConversationSnapshot>, StoreError> {
    let mut transaction = pool.begin().await?;
    let outcome = create_conversation_in_transaction_with_trusted_peer(
        &mut transaction,
        account_id,
        request,
        trusted_peer_account_id,
    )
    .await?;
    transaction.commit().await?;
    Ok(outcome)
}

pub(crate) async fn create_conversation_in_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    request: CreateConversationRequest,
) -> Result<InsertOutcome<ConversationSnapshot>, StoreError> {
    create_conversation_in_transaction_with_trusted_peer(transaction, account_id, request, None)
        .await
}

async fn create_conversation_in_transaction_with_trusted_peer(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    request: CreateConversationRequest,
    trusted_peer_account_id: Option<&str>,
) -> Result<InsertOutcome<ConversationSnapshot>, StoreError> {
    let shared_title = normalize_title(request.shared_title.as_deref())?;
    let members = normalized_members(account_id, &request.member_account_ids);
    let client_session_id = normalize_client_session_id(Some(&request.client_session_id))?
        .ok_or(StoreError::InvalidInput("client session id is required"))?;
    let client_session_id =
        account_scoped_client_session_id(account_id, request.kind, &members, client_session_id)?;
    let mut client_session_id = normalize_client_session_id(Some(&client_session_id))?
        .ok_or(StoreError::InvalidInput("client session id is required"))?;
    match request.kind {
        ConversationKind::Direct if members.len() != 2 => {
            return Err(StoreError::InvalidInput(
                "a direct conversation must have exactly two members",
            ));
        }
        ConversationKind::Group if !(2..=MAX_GROUP_MEMBERS).contains(&members.len()) => {
            return Err(StoreError::InvalidInput("group member count is invalid"));
        }
        ConversationKind::Ai if members.is_empty() || members.len() > MAX_GROUP_MEMBERS => {
            return Err(StoreError::InvalidInput(
                "AI conversation member count is invalid",
            ));
        }
        _ => {}
    }
    if request.kind == ConversationKind::Direct {
        client_session_id =
            normalized_direct_session_id(client_session_id, &members, trusted_peer_account_id)?;
    }
    let request_fingerprint = fingerprint(&CreationIntent {
        kind: request.kind,
        shared_title: &shared_title,
        client_session_id: &client_session_id,
        member_account_ids: &members,
    })?;

    advisory_operation_lock(transaction, account_id, request.client_operation_id).await?;
    advisory_session_lock(transaction, &client_session_id).await?;
    let registered_fork: (bool,) =
        query_as("SELECT EXISTS(SELECT 1 FROM cloud_session_forks WHERE fork_session_id = $1)")
            .bind(&client_session_id)
            .fetch_one(&mut **transaction)
            .await?;
    if !fork_session_kind_allowed(registered_fork.0, request.kind) {
        return Err(StoreError::InvalidInput(
            "fork sessions must be Agent conversations",
        ));
    }
    let existing: Option<(Uuid, String)> = query_as(
        "SELECT conversation_id, creation_fingerprint \
         FROM cloud_chat_conversations \
         WHERE created_by_account_id = $1 AND client_operation_id = $2",
    )
    .bind(account_id)
    .bind(request.client_operation_id)
    .fetch_optional(&mut **transaction)
    .await?;
    if let Some((conversation_id, stored_fingerprint)) = existing {
        if stored_fingerprint != request_fingerprint {
            return Err(StoreError::IdempotencyKeyReused);
        }
        let conversation = load_conversation(transaction, conversation_id, account_id).await?;
        return Ok(InsertOutcome {
            value: conversation,
            inserted: false,
        });
    }

    // Every device derives the same local session identity for a direct or
    // group chat. Resolve that identity before inserting so two devices (or
    // two members racing to open the same chat) converge on one server row.
    {
        let existing: Option<(Uuid, String)> = query_as(
            "SELECT conversation_id, kind FROM cloud_chat_conversations \
             WHERE legacy_session_id = $1 FOR UPDATE",
        )
        .bind(&client_session_id)
        .fetch_optional(&mut **transaction)
        .await?;
        if let Some((conversation_id, stored_kind)) = existing {
            if stored_kind != request.kind.as_str() {
                return Err(StoreError::IdempotencyKeyReused);
            }
            require_active_member(transaction, conversation_id, account_id).await?;
            let stored_members = active_member_ids(transaction, conversation_id).await?;
            if stored_members != members {
                return Err(StoreError::IdempotencyKeyReused);
            }
            let conversation = load_conversation(transaction, conversation_id, account_id).await?;
            return Ok(InsertOutcome {
                value: conversation,
                inserted: false,
            });
        }
    }

    let existing_accounts: (i64,) =
        query_as("SELECT COUNT(*) FROM cloud_accounts WHERE account_id = ANY($1)")
            .bind(&members)
            .fetch_one(&mut **transaction)
            .await?;
    if existing_accounts.0 != members.len() as i64 {
        return Err(StoreError::InvalidInput(
            "one or more conversation members do not exist",
        ));
    }
    let peers = members
        .iter()
        .filter(|member| member.as_str() != account_id)
        .cloned()
        .collect::<Vec<_>>();
    if !peers.is_empty() {
        let authorized_count: (i64,) = query_as(
            "SELECT COUNT(*) FROM unnest($2::TEXT[]) AS peer(account_id) \
             WHERE peer.account_id = $3 OR EXISTS ( \
               SELECT 1 FROM cloud_contacts contact \
               WHERE contact.account_id = $1 AND contact.peer_account_id = peer.account_id \
             )",
        )
        .bind(account_id)
        .bind(&peers)
        .bind(trusted_peer_account_id)
        .fetch_one(&mut **transaction)
        .await?;
        if authorized_count.0 != peers.len() as i64 {
            return Err(StoreError::Forbidden);
        }
    }

    let conversation_id = Uuid::now_v7();
    query(
        "INSERT INTO cloud_chat_conversations \
         (conversation_id, kind, shared_title, created_by_account_id, client_operation_id, \
          creation_fingerprint, legacy_session_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(conversation_id)
    .bind(request.kind.as_str())
    .bind(&shared_title)
    .bind(account_id)
    .bind(request.client_operation_id)
    .bind(&request_fingerprint)
    .bind(&client_session_id)
    .execute(&mut **transaction)
    .await?;
    for member in &members {
        query(
            "INSERT INTO cloud_chat_conversation_members \
             (conversation_id, account_id, role) VALUES ($1, $2, $3)",
        )
        .bind(conversation_id)
        .bind(member)
        .bind(if member == account_id {
            "owner"
        } else {
            "member"
        })
        .execute(&mut **transaction)
        .await?;
    }
    let conversation = load_conversation(transaction, conversation_id, account_id).await?;
    for member in &members {
        let projection = if member == account_id {
            conversation.clone()
        } else {
            load_conversation(transaction, conversation_id, member).await?
        };
        let payload = json!({ "conversation": &projection });
        insert_sync_event(
            transaction,
            member,
            "conversation.created",
            Some(conversation_id),
            Some(conversation_id),
            Some(projection.version),
            &payload,
        )
        .await?;
    }
    Ok(InsertOutcome {
        value: conversation,
        inserted: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_person_sessions_are_canonicalized_by_member_identity() {
        let members = vec!["acct_a".to_string(), "acct_b".to_string()];
        assert_eq!(
            normalized_direct_session_id(
                "session:direct-person:stale:order".to_string(),
                &members,
                None,
            )
            .unwrap(),
            "session:direct-person:acct_a:acct_b"
        );
    }

    #[test]
    fn direct_sessions_reject_seed_and_untrusted_system_agent_ids() {
        let members = vec!["acct_a".to_string(), "acct_b".to_string()];
        assert!(normalized_direct_session_id(
            "session:seed:obsolete-direct".to_string(),
            &members,
            None,
        )
        .is_err());
        assert!(normalized_direct_session_id(
            "session:direct-system-agent:acct_a:agent".to_string(),
            &members,
            None,
        )
        .is_err());
        assert!(normalized_direct_session_id(
            "session:direct-agent:acct_b:agent".to_string(),
            &members,
            None,
        )
        .is_ok());
        assert!(normalized_direct_session_id(
            "session:direct-system-agent:acct_a:agent".to_string(),
            &members,
            Some("acct_b"),
        )
        .is_ok());
    }

    #[test]
    fn legacy_default_self_agent_session_is_scoped_per_account() {
        let first = account_scoped_client_session_id(
            "acct_first",
            ConversationKind::Ai,
            &["acct_first".to_string()],
            LEGACY_DEFAULT_SELF_AGENT_SESSION_ID.to_string(),
        )
        .expect("scope first account");
        let second = account_scoped_client_session_id(
            "acct_second",
            ConversationKind::Ai,
            &["acct_second".to_string()],
            LEGACY_DEFAULT_SELF_AGENT_SESSION_ID.to_string(),
        )
        .expect("scope second account");

        assert_eq!(first, "session:self-agent:acct_first:default");
        assert_eq!(second, "session:self-agent:acct_second:default");
        assert_ne!(first, second);
    }

    #[test]
    fn legacy_default_self_agent_session_rejects_non_private_shapes() {
        assert!(matches!(
            account_scoped_client_session_id(
                "acct_first",
                ConversationKind::Ai,
                &["acct_first".to_string(), "acct_second".to_string()],
                LEGACY_DEFAULT_SELF_AGENT_SESSION_ID.to_string(),
            ),
            Err(StoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn registered_fork_ids_allow_only_agent_conversations() {
        assert!(fork_session_kind_allowed(true, ConversationKind::Ai));
        assert!(!fork_session_kind_allowed(true, ConversationKind::Group));
        assert!(!fork_session_kind_allowed(true, ConversationKind::Direct));
        assert!(fork_session_kind_allowed(false, ConversationKind::Group));
    }
}

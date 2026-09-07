//! Shared human messages and explicit, identity-bound Agent mentions.
use super::*;

type ConversationMessageRow = (
    Uuid,
    String,
    String,
    String,
    Value,
    Option<String>,
    String,
    Value,
    i64,
);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SendRequest {
    client_message_id: Uuid,
    text: String,
    #[serde(default)]
    mentions: Vec<Value>,
}

fn invokes_agent(text: &str, mentions: &[Value], agent: &str) -> bool {
    let utf16: Vec<u16> = text.encode_utf16().collect();
    mentions.iter().any(|mention| {
        if mention["targetKind"] != "agent"
            || mention["agentId"]
                .as_str()
                .or(mention["targetIdentityId"].as_str())
                != Some(agent)
        {
            return false;
        }
        let Some(start) = mention["startUtf16"]
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
        else {
            return false;
        };
        let Some(length) = mention["lengthUtf16"]
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
        else {
            return false;
        };
        let Some(end) = start.checked_add(length).filter(|end| *end <= utf16.len()) else {
            return false;
        };
        let Ok(token) = String::from_utf16(&utf16[start..end]) else {
            return false;
        };
        let Some(handle) = token.strip_prefix('@') else {
            return false;
        };
        !handle.is_empty()
            && handle.chars().all(char::is_alphanumeric)
            && (start == 0
                || String::from_utf16_lossy(&utf16[..start])
                    .chars()
                    .next_back()
                    .is_some_and(|ch| ch.is_whitespace() || ch.is_ascii_punctuation()))
            && (end == utf16.len()
                || String::from_utf16_lossy(&utf16[end..])
                    .chars()
                    .next()
                    .is_some_and(|ch| !ch.is_alphanumeric()))
    })
}

fn valid_mentions(mentions: &[Value]) -> bool {
    mentions.len() <= 32
        && mentions.iter().all(|mention| {
            let Some(fields) = mention.as_object() else {
                return false;
            };
            mention["label"]
                .as_str()
                .is_some_and(|label| !label.is_empty() && label.chars().count() <= 128)
                && fields.iter().all(|(key, value)| match key.as_str() {
                    "startUtf16" | "lengthUtf16" => {
                        value.is_null() || value.as_u64().is_some_and(|n| n <= 32_000)
                    }
                    "label" | "targetKind" | "targetIdentityId" | "displayText"
                    | "sourceHostId" | "nodeId" | "humanId" | "agentId" | "displayLabel" => {
                        value.is_null()
                            || value.as_str().is_some_and(|text| {
                                text.len() <= 512 && !text.chars().any(char::is_control)
                            })
                    }
                    _ => false,
                })
        })
}

pub(super) async fn send(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(id): Path<Uuid>,
    Json(input): Json<SendRequest>,
) -> Result<Json<Snapshot>, ApiError> {
    if input.text.trim().is_empty() || input.text.len() > 32_000 || !valid_mentions(&input.mentions)
    {
        return Err(error(StatusCode::BAD_REQUEST, "invalid_subsession_message"));
    }
    let pool = state.db_pool();
    let visible = snapshot(pool, id, &session.account_id, false).await?;
    let invokes = invokes_agent(&input.text, &input.mentions, &visible.agent_id);
    if invokes {
        let allowed:(bool,)=query_as("SELECT EXISTS(SELECT 1 FROM cloud_agent_subsessions s JOIN cloud_chat_conversation_members m ON m.conversation_id=s.parent_conversation_id AND m.account_id=s.owner_account_id AND m.membership_state='active' WHERE s.subsession_id=$1 AND (s.agent_id='cloud-agent:'||s.owner_account_id OR EXISTS(SELECT 1 FROM cloud_agent_definitions d WHERE d.agent_id=s.agent_id AND d.owner_account_id=s.owner_account_id AND d.status='active' AND (d.access_scope='participant_conversations' OR s.owner_account_id=$2))))")
            .bind(id).bind(&session.account_id).fetch_one(pool).await.map_err(db_error)?;
        if !allowed.0 {
            return Err(error(StatusCode::FORBIDDEN, "subsession_agent_unavailable"));
        }
    }
    let mut tx = pool.begin().await.map_err(db_error)?;
    // ponytail: serialize subsession admission; use per-session locks if throughput requires it.
    query("SELECT pg_advisory_xact_lock(81208411)")
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    let member:(bool,)=query_as("SELECT EXISTS(SELECT 1 FROM cloud_agent_subsessions s JOIN cloud_chat_conversation_members m ON m.conversation_id=s.parent_conversation_id WHERE s.subsession_id=$1 AND m.account_id=$2 AND m.membership_state='active')").bind(id).bind(&session.account_id).fetch_one(&mut *tx).await.map_err(db_error)?;
    if !member.0 {
        return Err(error(StatusCode::NOT_FOUND, "subsession_not_found"));
    }
    let previous:Option<(Uuid,String,String,Value)>=query_as("SELECT subsession_id,sender_account_id,text,mentions FROM cloud_agent_subsession_chat WHERE message_id=$1")
        .bind(input.client_message_id).fetch_optional(&mut *tx).await.map_err(db_error)?;
    if let Some((stored, actor, text, mentions)) = previous {
        if stored != id
            || actor != session.account_id
            || text != input.text
            || mentions != json!(input.mentions)
        {
            return Err(error(
                StatusCode::CONFLICT,
                "subsession_message_identity_conflict",
            ));
        }
    } else {
        let run_id = if invokes {
            let run_id = format!("car_{}", Uuid::new_v4().simple());
            let inherited:Option<(String,Value,Vec<String>)>=query_as("SELECT r.system_prompt,r.runtime_route_json,ARRAY(SELECT jsonb_array_elements_text(r.subsession_write_scope)) FROM cloud_agent_fallback_runs r WHERE r.subsession_id=$1 OR (r.session_id=$2 AND r.request_message_id IN ($3,regexp_replace($3,'^ios_','')) AND r.owner_account_id=$4 AND r.execution_agent_id=$5) ORDER BY (r.subsession_id=$1) DESC NULLS LAST,r.created_at DESC LIMIT 1")
                .bind(id).bind(&visible.parent_session_id).bind(&visible.parent_request_id).bind(&visible.owner_account_id).bind(&visible.agent_id).fetch_optional(&mut *tx).await.map_err(db_error)?;
            let (system,route,scope)=inherited.unwrap_or_else(||(format!("You are {}. Agent identity: {}. Owner: {}. Continue the same execution subsession. Do not create a channel or another subsession. Respond only to the current explicit mention; ordinary participant messages are conversation context.",visible.agent_display_name,visible.agent_id,visible.owner_account_id),json!({}),Vec::new()));
            let sandbox = crate::cloud_agent_runtime::sandboxes::ensure_sandbox_for_run(
                pool,
                &format!("subsession:{id}"),
                &visible.owner_account_id,
                &session.account_id,
            )
            .await
            .map_err(db_error)?;
            let now = chrono::Utc::now().to_rfc3339();
            query("INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,system_prompt,sandbox_id,runtime_route_json,created_at,updated_at,execution_backend,execution_agent_id,subsession_id,subsession_write_scope) VALUES($1,$2,$3,$4,$5,$6,'queued',$7,$8,$9,$10,$11,$11,'cloud',$12,$13,$14)")
                .bind(&run_id).bind(format!("subsession:{id}:{}",input.client_message_id)).bind(input.client_message_id.to_string()).bind(&visible.parent_session_id).bind(&visible.owner_account_id).bind(&session.account_id).bind(&input.text).bind(system).bind(sandbox.sandbox_id).bind(route).bind(now).bind(&visible.agent_id).bind(id).bind(json!(scope)).execute(&mut *tx).await.map_err(db_error)?;
            Some(run_id)
        } else {
            None
        };
        query("INSERT INTO cloud_agent_subsession_chat(message_id,subsession_id,sender_account_id,text,mentions,run_id) VALUES($1,$2,$3,$4,$5,$6)")
            .bind(input.client_message_id).bind(id).bind(&session.account_id).bind(&input.text).bind(json!(input.mentions)).bind(run_id).execute(&mut *tx).await.map_err(db_error)?;
        query("UPDATE cloud_agent_subsessions SET version=version+1,updated_at=now() WHERE subsession_id=$1").bind(id).execute(&mut *tx).await.map_err(db_error)?;
    }
    tx.commit().await.map_err(db_error)?;
    snapshot(pool, id, &session.account_id, true)
        .await
        .map(Json)
}

pub(super) async fn messages(pool: &PgPool, id: Uuid) -> Result<Vec<Value>, ApiError> {
    let rows:Vec<ConversationMessageRow>=query_as("SELECT c.message_id,c.sender_account_id,a.display_name,c.text,c.mentions,CASE WHEN r.status='queued' AND NOT (s.status='running' OR EXISTS(SELECT 1 FROM cloud_agent_subsession_chat earlier JOIN cloud_agent_fallback_runs e ON e.run_id=earlier.run_id WHERE earlier.subsession_id=s.subsession_id AND earlier.sequence<c.sequence AND e.status IN ('queued','leased','running'))) THEN 'pending' ELSE r.status END,c.response_text,c.activity,(extract(epoch from c.created_at)*1000)::bigint FROM cloud_agent_subsession_chat c JOIN cloud_agent_subsessions s ON s.subsession_id=c.subsession_id JOIN cloud_accounts a ON a.account_id=c.sender_account_id LEFT JOIN cloud_agent_fallback_runs r ON r.run_id=c.run_id WHERE c.subsession_id=$1 ORDER BY c.sequence")
        .bind(id).fetch_all(pool).await.map_err(db_error)?;
    let mut messages = Vec::new();
    for (id, sender, name, text, mentions, status, response, activity, time) in rows {
        messages.push(json!({"id":id,"role":"user","text":text,"timestampMs":time,"senderAccountId":sender,"senderDisplayName":name,"mentions":mentions,"requestState":status}));
        if let Some(status) = status {
            messages.push(json!({"id":format!("reply:{id}"),"role":"assistant","text":response,"timestampMs":time+1,"requestId":id,"requestState":status,"activity":activity}));
        }
    }
    Ok(messages)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn execution_requires_an_explicit_valid_mention_of_the_bound_agent() {
        assert!(!valid_mentions(&[json!({"label":true})]));
        assert!(!valid_mentions(&[
            json!({"label":"Kordi","agentId":{"id":"other"}})
        ]));
        assert!(valid_mentions(&[
            json!({"label":"Kordi","agentId":"agent-one","startUtf16":0,"lengthUtf16":6})
        ]));
        let mention =
            json!({"targetKind":"agent","agentId":"agent-one","startUtf16":0,"lengthUtf16":6});
        assert!(invokes_agent(
            "@Kordi explain",
            std::slice::from_ref(&mention),
            "agent-one"
        ));
        assert!(!invokes_agent("@Kordi explain", &[], "agent-one"));
        assert!(!invokes_agent(
            "@Kordi explain",
            std::slice::from_ref(&mention),
            "agent-two"
        ));
        assert!(!invokes_agent(
            "hello everyone",
            std::slice::from_ref(&mention),
            "agent-one"
        ));
        assert!(!invokes_agent(
            "@KordiOther explain",
            &[mention],
            "agent-one"
        ));
    }
}

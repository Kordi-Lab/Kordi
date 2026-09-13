use super::*;
use kordi_tools::SessionAttachmentReference;
use serde_json::json;

pub(in crate::cloud_agent_runtime::runs) async fn references(
    pool: &PgPool,
    session: &str,
    ids: &[String],
    owner: &str,
    requester: &str,
) -> RunResult<Vec<SessionAttachmentReference>> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let viewers = vec![owner.to_string(), requester.to_string()];
    let rows:Vec<(String,String,i64,String,i64)>=query_as(
        "SELECT m.message_id::text,a.attachment_id,m.version::bigint,COALESCE(a.detected_content_type,a.content_type,'application/octet-stream'),COALESCE(a.size_bytes,-1)
         FROM cloud_chat_conversations c JOIN cloud_chat_messages m USING(conversation_id)
         JOIN cloud_chat_message_attachments link ON link.message_id=m.message_id JOIN cloud_attachments a USING(attachment_id)
         WHERE c.legacy_session_id=$1 AND m.message_id::text=ANY($2) AND m.deleted_at IS NULL AND a.finalized_at IS NOT NULL
         AND EXISTS(SELECT 1 FROM cloud_chat_conversation_members member WHERE member.conversation_id=c.conversation_id AND member.account_id=$3 AND member.membership_state='active')
         AND EXISTS(SELECT 1 FROM cloud_chat_conversation_members member WHERE member.conversation_id=c.conversation_id AND member.account_id=$4 AND member.membership_state='active')
         AND NOT EXISTS(SELECT 1 FROM cloud_chat_message_visibility v WHERE v.message_id=m.message_id AND v.account_id=ANY($5))
         AND NOT EXISTS(SELECT 1 FROM cloud_chat_attachment_visibility v WHERE v.message_id=m.message_id AND v.attachment_id=a.attachment_id AND v.account_id=ANY($5))
         ORDER BY m.conversation_sequence,link.position,a.attachment_id"
    ).bind(session).bind(ids).bind(owner).bind(requester).bind(viewers).fetch_all(pool).await?;
    Ok(rows
        .into_iter()
        .map(
            |(message_id, attachment_id, message_version, mime_type, size_bytes)| {
                SessionAttachmentReference {
                    message_id,
                    attachment_id,
                    message_version,
                    mime_type,
                    size_bytes,
                }
            },
        )
        .collect())
}

pub(super) async fn read(
    state: &ServerState,
    run_id: &str,
    actor: &ContextActor,
    scope: &ContextScope,
    args: &Value,
) -> RunResult<Value> {
    let ids = args["messageIds"]
        .as_array()
        .filter(|ids| ids.len() == 1)
        .ok_or(RunError::ContextUnavailable(
            "Attachment mode requires exactly one messageIds entry.",
        ))?;
    let id = ids[0].as_str().ok_or(RunError::NotFound)?.to_string();
    let attachment = args["attachmentId"].as_str().ok_or(RunError::NotFound)?;
    let version =
        args["expectedVersion"]
            .as_i64()
            .filter(|v| *v > 0)
            .ok_or(RunError::ContextUnavailable(
            "Refresh the attachment reference and supply its messageVersion as expectedVersion.",
        ))?;
    let pool = state.db_pool();
    let selected = references(
        pool,
        &scope.session_id,
        std::slice::from_ref(&id),
        &scope.owner,
        &scope.requester,
    )
    .await?
    .into_iter()
    .find(|r| r.attachment_id == attachment)
    .ok_or(RunError::NotFound)?;
    if selected.message_version != version {
        return Err(RunError::ContextUnavailable(
            "The message changed. Read its attachment references again before retrying.",
        ));
    }
    if !selected.mime_type.starts_with("image/") {
        return Err(RunError::ContextUnavailable(
            "Only static images and stickers are supported by this attachment reader.",
        ));
    }
    let max = kordi_tools::image_input::MAX_IMAGE_BYTES;
    if selected.size_bytes > max as i64 {
        return Err(RunError::ContextUnavailable(
            "Image exceeds 4 MiB. Use a smaller image.",
        ));
    }
    let source:(String,Option<String>)=query_as("SELECT object_key,sha256_hex FROM cloud_attachments WHERE attachment_id=$1 AND finalized_at IS NOT NULL").bind(attachment).fetch_one(pool).await?;
    let config = state.s3().ok_or(RunError::ContextUnavailable(
        "Attachment storage is unavailable.",
    ))?;
    let url = crate::attachments::presign_download_url(config, &source.0)
        .map_err(|_| RunError::ContextUnavailable("Attachment download could not be prepared."))?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| RunError::ContextUnavailable("Attachment download is unavailable."))?;
    let mut download = client.get(url.to_string()).send().await.map_err(|_| {
        RunError::ContextUnavailable("Attachment download failed. Retry reading the attachment.")
    })?;
    if !download.status().is_success() {
        return Err(RunError::ContextUnavailable(
            "Attachment content is unavailable.",
        ));
    }
    if download
        .content_length()
        .is_some_and(|len| len > max as u64)
    {
        return Err(RunError::ContextUnavailable(
            "Image exceeds 4 MiB. Use a smaller image.",
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = download
        .chunk()
        .await
        .map_err(|_| RunError::ContextUnavailable("Attachment download was interrupted."))?
    {
        if bytes.len() + chunk.len() > max {
            return Err(RunError::ContextUnavailable(
                "Image exceeds 4 MiB. Use a smaller image.",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    let content=tokio::task::spawn_blocking(move || kordi_tools::image_input::static_image_content(&bytes)).await
        .map_err(|_|RunError::ContextUnavailable("Image decoding failed."))?
        .map_err(|_|RunError::ContextUnavailable("This image is corrupt, animated, unsupported, or exceeds decoding limits. Use a static PNG, JPEG, WebP, or GIF."))?;
    // Access, visibility and source version can change while bytes are loading.
    let current_scope = super::authorize(pool, run_id, actor).await?;
    let current = references(
        pool,
        &current_scope.session_id,
        std::slice::from_ref(&id),
        &current_scope.owner,
        &current_scope.requester,
    )
    .await?;
    if !current.iter().any(|r| r == &selected) {
        return Err(RunError::NotFound);
    }
    let current_source:Option<(String,Option<String>)>=query_as("SELECT object_key,sha256_hex FROM cloud_attachments WHERE attachment_id=$1 AND finalized_at IS NOT NULL").bind(attachment).fetch_optional(pool).await?;
    if current_source.as_ref() != Some(&source) {
        return Err(RunError::NotFound);
    }
    let mut response = super::messages::read(
        pool,
        scope,
        &json!({"mode":"messages","messageIds":[id],"limit":1}),
        false,
    )
    .await?;
    let expected = serde_json::to_value(&selected).map_err(|_| RunError::NotFound)?;
    if !response["messages"].as_array().is_some_and(|messages| {
        messages.iter().any(|message| {
            message["attachments"]
                .as_array()
                .is_some_and(|refs| refs.contains(&expected))
        })
    }) {
        return Err(RunError::NotFound);
    }
    response["media"] = json!([content]);
    Ok(response)
}

use super::*;

fn normalized_meme_content_type(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "image/png" => Some("image/png"),
        "image/jpeg" | "image/jpg" => Some("image/jpeg"),
        "image/gif" => Some("image/gif"),
        "image/webp" => Some("image/webp"),
        _ => None,
    }
}

pub(super) fn meme_attachment_metadata(
    content: &Value,
    attachment_ids: &[String],
) -> Result<Vec<(String, &'static str)>, StoreError> {
    let Some(attachments) = content
        .as_object()
        .and_then(|value| value.get("legacy_attachments"))
    else {
        return Ok(Vec::new());
    };
    let attachments = attachments
        .as_array()
        .ok_or(StoreError::InvalidInput("attachment metadata is invalid"))?;
    let mut memes = Vec::new();
    for attachment in attachments {
        let attachment = attachment
            .as_object()
            .ok_or(StoreError::InvalidInput("attachment metadata is invalid"))?;
        let Some(subtype) = attachment.get("subtype") else {
            continue;
        };
        if subtype.is_null() {
            continue;
        }
        if subtype.as_str() != Some("meme") {
            return Err(StoreError::InvalidInput("attachment subtype is invalid"));
        }
        let attachment_id = attachment
            .get("attachmentId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| attachment_ids.iter().any(|candidate| candidate == value))
            .ok_or(StoreError::InvalidInput(
                "meme attachment metadata is invalid",
            ))?;
        attachment
            .get("altText")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty() && value.chars().count() <= 500)
            .ok_or(StoreError::InvalidInput(
                "meme attachment metadata is invalid",
            ))?;
        if attachment.get("kind").and_then(Value::as_str) != Some("image") {
            return Err(StoreError::InvalidInput(
                "meme attachment metadata is invalid",
            ));
        }
        let mime_type = attachment
            .get("mimeType")
            .and_then(Value::as_str)
            .and_then(normalized_meme_content_type)
            .ok_or(StoreError::InvalidInput(
                "meme attachment metadata is invalid",
            ))?;
        memes.push((attachment_id.to_string(), mime_type));
    }
    Ok(memes)
}

pub(super) async fn validate_meme_attachment_bytes(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    memes: &[(String, &'static str)],
) -> Result<(), StoreError> {
    if memes.is_empty() {
        return Ok(());
    }
    let ids = memes.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>();
    let rows: Vec<(String, Option<String>, Option<String>)> = query_as(
        "SELECT attachment_id, content_type, detected_content_type FROM cloud_attachments \
         WHERE attachment_id = ANY($1) AND owner_account_id = $2 AND finalized_at IS NOT NULL",
    )
    .bind(&ids)
    .bind(account_id)
    .fetch_all(&mut **transaction)
    .await?;
    if rows.len() != memes.len() {
        return Err(StoreError::InvalidInput(
            "meme attachment content is invalid",
        ));
    }
    for (attachment_id, metadata_type) in memes {
        let Some((_, declared_type, detected_type)) = rows
            .iter()
            .find(|(stored_attachment_id, _, _)| stored_attachment_id == attachment_id)
        else {
            return Err(StoreError::InvalidInput(
                "meme attachment content is invalid",
            ));
        };
        let declared_type = declared_type
            .as_deref()
            .and_then(normalized_meme_content_type);
        let detected_type = detected_type
            .as_deref()
            .and_then(normalized_meme_content_type);
        if declared_type != Some(*metadata_type) || detected_type != Some(*metadata_type) {
            return Err(StoreError::InvalidInput(
                "meme attachment content is invalid",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{meme_attachment_metadata, normalized_meme_content_type};

    #[test]
    fn extracts_valid_meme_attachment_metadata() {
        let content = json!({
            "legacy_attachments": [{
                "attachmentId": "att_1",
                "kind": "image",
                "subtype": "meme",
                "altText": "A useful description",
                "mimeType": "image/jpg"
            }]
        });
        let attachments = vec!["att_1".to_string()];
        assert_eq!(
            meme_attachment_metadata(&content, &attachments).unwrap(),
            vec![("att_1".to_string(), "image/jpeg")]
        );
    }

    #[test]
    fn rejects_inaccessible_or_unlinked_meme_metadata() {
        let missing_alt = json!({
            "legacy_attachments": [{
                "attachmentId": "att_1",
                "kind": "image",
                "subtype": "meme",
                "altText": "",
                "mimeType": "image/png"
            }]
        });
        assert!(meme_attachment_metadata(&missing_alt, &["att_1".to_string()]).is_err());
        assert!(meme_attachment_metadata(
            &json!({ "legacy_attachments": [{
                "attachmentId": "att_other",
                "kind": "image",
                "subtype": "meme",
                "altText": "Description",
                "mimeType": "image/png"
            }]}),
            &["att_1".to_string()]
        )
        .is_err());
        assert_eq!(normalized_meme_content_type("image/svg+xml"), None);
    }
}

use super::*;

fn normalized_image_content_type(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "image/png" => Some("image/png"),
        "image/jpeg" | "image/jpg" => Some("image/jpeg"),
        "image/gif" => Some("image/gif"),
        "image/webp" => Some("image/webp"),
        _ => None,
    }
}

/// Collects every attachment that declares an expressive subtype so its stored
/// bytes can be checked against the declared type. "meme" is retired and no
/// client emits it; it stays accepted so stored messages from that era survive
/// an edit, with no rules of its own.
pub(super) fn subtyped_attachment_metadata(
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
    let mut images = Vec::new();
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
        if !matches!(subtype.as_str(), Some("sticker") | Some("meme")) {
            return Err(StoreError::InvalidInput("attachment subtype is invalid"));
        }
        let attachment_id = attachment
            .get("attachmentId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| attachment_ids.iter().any(|candidate| candidate == value))
            .ok_or(StoreError::InvalidInput(
                "image attachment metadata is invalid",
            ))?;
        let alt_text = attachment
            .get("altText")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if alt_text.chars().count() > 500 {
            return Err(StoreError::InvalidInput(
                "image attachment metadata is invalid",
            ));
        }
        if attachment.get("kind").and_then(Value::as_str) != Some("image") {
            return Err(StoreError::InvalidInput(
                "image attachment metadata is invalid",
            ));
        }
        let mime_type = attachment
            .get("mimeType")
            .and_then(Value::as_str)
            .and_then(normalized_image_content_type)
            .ok_or(StoreError::InvalidInput(
                "image attachment metadata is invalid",
            ))?;
        images.push((attachment_id.to_string(), mime_type));
    }
    Ok(images)
}

pub(super) async fn validate_subtyped_attachment_bytes(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    images: &[(String, &'static str)],
) -> Result<(), StoreError> {
    if images.is_empty() {
        return Ok(());
    }
    let ids = images.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>();
    let rows: Vec<(String, Option<String>, Option<String>)> = query_as(
        "SELECT attachment_id, content_type, detected_content_type FROM cloud_attachments \
         WHERE attachment_id = ANY($1) AND owner_account_id = $2 AND finalized_at IS NOT NULL",
    )
    .bind(&ids)
    .bind(account_id)
    .fetch_all(&mut **transaction)
    .await?;
    if rows.len() != images.len() {
        return Err(StoreError::InvalidInput(
            "image attachment content is invalid",
        ));
    }
    for (attachment_id, metadata_type) in images {
        let Some((_, declared_type, detected_type)) = rows
            .iter()
            .find(|(stored_attachment_id, _, _)| stored_attachment_id == attachment_id)
        else {
            return Err(StoreError::InvalidInput(
                "image attachment content is invalid",
            ));
        };
        let declared_type = declared_type
            .as_deref()
            .and_then(normalized_image_content_type);
        let detected_type = detected_type
            .as_deref()
            .and_then(normalized_image_content_type);
        if declared_type != Some(*metadata_type) || detected_type != Some(*metadata_type) {
            return Err(StoreError::InvalidInput(
                "image attachment content is invalid",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{normalized_image_content_type, subtyped_attachment_metadata};

    #[test]
    fn retired_meme_metadata_still_resolves_for_stored_messages() {
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
            subtyped_attachment_metadata(&content, &attachments).unwrap(),
            vec![("att_1".to_string(), "image/jpeg")]
        );
    }

    #[test]
    fn extracts_sticker_attachment_metadata_without_alt_text() {
        let content = json!({
            "legacy_attachments": [{
                "attachmentId": "att_1",
                "kind": "image",
                "subtype": "sticker",
                "mimeType": "image/webp"
            }]
        });
        let attachments = vec!["att_1".to_string()];
        assert_eq!(
            subtyped_attachment_metadata(&content, &attachments).unwrap(),
            vec![("att_1".to_string(), "image/webp")]
        );
    }

    #[test]
    fn rejects_over_long_alt_text_and_unsupported_image_types() {
        let long_alt = json!({
            "legacy_attachments": [{
                "attachmentId": "att_1",
                "kind": "image",
                "subtype": "sticker",
                "altText": "a".repeat(501),
                "mimeType": "image/png"
            }]
        });
        assert!(subtyped_attachment_metadata(&long_alt, &["att_1".to_string()]).is_err());
        assert_eq!(normalized_image_content_type("image/svg+xml"), None);
    }

    #[test]
    fn rejects_unlinked_or_unsupported_sticker_metadata() {
        let unlinked = json!({
            "legacy_attachments": [{
                "attachmentId": "att_other",
                "kind": "image",
                "subtype": "sticker",
                "mimeType": "image/png"
            }]
        });
        assert!(subtyped_attachment_metadata(&unlinked, &["att_1".to_string()]).is_err());

        let unsupported_type = json!({
            "legacy_attachments": [{
                "attachmentId": "att_1",
                "kind": "image",
                "subtype": "sticker",
                "mimeType": "image/svg+xml"
            }]
        });
        assert!(subtyped_attachment_metadata(&unsupported_type, &["att_1".to_string()]).is_err());

        let unknown_subtype = json!({
            "legacy_attachments": [{
                "attachmentId": "att_1",
                "kind": "image",
                "subtype": "collage",
                "mimeType": "image/png"
            }]
        });
        assert!(subtyped_attachment_metadata(&unknown_subtype, &["att_1".to_string()]).is_err());
    }
}

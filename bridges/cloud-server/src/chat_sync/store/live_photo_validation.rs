use super::*;

const MAX_PHOTO_BYTES: i64 = 32 * 1024 * 1024;
const MAX_MOTION_BYTES: i64 = 256 * 1024 * 1024;

type LiveResourceRow = (String, Option<String>, Option<String>, Option<i64>);

pub(super) struct LiveResource {
    id: String,
    mime: String,
    size: i64,
    limit: i64,
}

pub(super) fn live_photo_resources(
    content: &Value,
    attachment_ids: &[String],
) -> Result<Vec<LiveResource>, StoreError> {
    let mut resources = Vec::new();
    let Some(attachments) = content.get("legacy_attachments").and_then(Value::as_array) else {
        return Ok(resources);
    };
    for attachment in attachments {
        let Some(live) = attachment.get("livePhoto").filter(|v| !v.is_null()) else {
            continue;
        };
        if attachment.get("kind").and_then(Value::as_str) != Some("image")
            || attachment.get("subtype").is_some_and(|v| !v.is_null())
        {
            return Err(StoreError::InvalidInput(
                "Live Photo must be an ordinary image attachment",
            ));
        }
        let mut ids = BTreeSet::new();
        for (value, allowed, limit) in [
            (
                attachment,
                &["image/jpeg", "image/heic", "image/heif"][..],
                MAX_PHOTO_BYTES,
            ),
            (&live["video"], &["video/quicktime"][..], MAX_MOTION_BYTES),
            (&live["playback"], &["video/mp4"][..], MAX_MOTION_BYTES),
        ] {
            let id = value
                .get("attachmentId")
                .and_then(Value::as_str)
                .filter(|v| {
                    !v.is_empty() && attachment_ids.iter().any(|id| id == v) && ids.insert(*v)
                })
                .ok_or(StoreError::InvalidInput(
                    "Live Photo resources must be distinct linked attachments",
                ))?;
            let mime = value
                .get("mimeType")
                .and_then(Value::as_str)
                .filter(|v| allowed.contains(v))
                .ok_or(StoreError::InvalidInput(
                    "Live Photo resource media type is invalid",
                ))?;
            let size = value
                .get("sizeBytes")
                .and_then(Value::as_i64)
                .filter(|v| *v > 0 && *v <= limit)
                .ok_or(StoreError::InvalidInput(
                    "Live Photo resource size is invalid",
                ))?;
            resources.push(LiveResource {
                id: id.to_owned(),
                mime: mime.to_owned(),
                size,
                limit,
            });
        }
    }
    Ok(resources)
}

pub(super) async fn validate_live_photo_resources(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    resources: &[LiveResource],
) -> Result<(), StoreError> {
    if resources.is_empty() {
        return Ok(());
    }
    let ids: Vec<&str> = resources.iter().map(|r| r.id.as_str()).collect();
    let rows: Vec<LiveResourceRow> = query_as(
        "SELECT attachment_id, content_type, detected_content_type, size_bytes FROM cloud_attachments \
         WHERE attachment_id = ANY($1) AND owner_account_id = $2 AND finalized_at IS NOT NULL",
    ).bind(ids).bind(account_id).fetch_all(&mut **transaction).await?;
    for resource in resources {
        let valid = rows.iter().any(|(id, declared, detected, size)| {
            id == &resource.id
                && declared.as_deref() == Some(resource.mime.as_str())
                && detected.as_deref() == Some(resource.mime.as_str())
                && *size == Some(resource.size)
                && resource.size <= resource.limit
        });
        if !valid {
            return Err(StoreError::InvalidInput(
                "Live Photo resources are unavailable or invalid",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn live_photo_requires_all_distinct_linked_typed_resources() {
        let ids = vec!["photo".into(), "video".into(), "playback".into()];
        let mut content = json!({ "legacy_attachments": [{
            "attachmentId": "photo", "kind": "image", "mimeType": "image/heic", "sizeBytes": 100,
            "livePhoto": {
                "video": { "attachmentId": "video", "mimeType": "video/quicktime", "sizeBytes": 200 },
                "playback": { "attachmentId": "playback", "mimeType": "video/mp4", "sizeBytes": 300 }
            }
        }] });
        assert_eq!(live_photo_resources(&content, &ids).unwrap().len(), 3);
        assert!(live_photo_resources(&content, &ids[..1]).is_err());
        content["legacy_attachments"][0]["livePhoto"]["video"]["attachmentId"] = json!("photo");
        assert!(live_photo_resources(&content, &ids).is_err());
        content["legacy_attachments"][0]["livePhoto"]["video"]["attachmentId"] = json!("video");
        content["legacy_attachments"][0]["livePhoto"]["video"]["sizeBytes"] =
            json!(MAX_MOTION_BYTES + 1);
        assert!(live_photo_resources(&content, &ids).is_err());
        assert!(live_photo_resources(&json!({}), &[]).unwrap().is_empty());
    }
}

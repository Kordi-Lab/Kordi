use super::*;

pub(super) fn signup_avatar(
    account_id: &str,
    seed: &str,
    mutation: Option<&AvatarMutationRequest>,
    now: &str,
) -> Result<AvatarDescriptor, AvatarMutationError> {
    let initial = AvatarDescriptor {
        entity_type: "human".to_string(),
        entity_id: account_id.to_string(),
        source: "generated".to_string(),
        style: HUMAN_AVATAR_STYLE.to_string(),
        seed: seed.to_string(),
        renderer_version: AVATAR_RENDERER_VERSION.to_string(),
        uploaded_asset: None,
        version: 1,
        updated_at: now.to_string(),
    };
    mutation.map_or(Ok(initial.clone()), |value| {
        apply_avatar_mutation(&initial, value, now)
    })
}

pub(super) fn deferred_signup_avatar_bytes(
    mutation: Option<&AvatarMutationRequest>,
) -> Result<Option<Vec<u8>>, crate::avatars::assets::AvatarAssetError> {
    mutation
        .and_then(|value| value.uploaded_asset.as_deref())
        .map(crate::avatars::assets::legacy_avatar_data)
        .transpose()
        .map(Option::flatten)
}

pub(super) async fn apply_deferred_signup_avatar(
    state: &ServerState,
    account_id: &str,
    current: &AvatarDescriptor,
    now: &str,
    bytes: Option<Vec<u8>>,
) {
    let (Some(bytes), Some(s3)) = (bytes, state.s3()) else {
        return;
    };
    let pool = state.db_pool();
    let Ok(marker) = crate::avatars::assets::store_avatar_asset(
        pool, s3, account_id, "human", account_id, bytes,
    )
    .await
    else {
        return;
    };
    let Ok(mut transaction) = pool.begin().await else {
        return;
    };
    let mutation = AvatarMutationRequest {
        action: "upload".to_string(),
        uploaded_asset: Some(marker.clone()),
        seed: None,
        expected_version: Some(current.version),
    };
    let Ok(uploaded) = apply_avatar_mutation(current, &mutation, now) else {
        return;
    };
    if crate::avatars::assets::activate_avatar_asset(
        &mut transaction,
        account_id,
        "human",
        account_id,
        &marker,
    )
    .await
    .is_err()
    {
        return;
    }
    let updated = query(
        "UPDATE cloud_accounts SET avatar_url = $1, avatar_source = $2, \
         avatar_style = $3, avatar_seed = $4, avatar_renderer_version = $5, \
         avatar_version = $6, avatar_updated_at = $7, updated_at = $7 \
         WHERE account_id = $8 AND avatar_version = $9",
    )
    .bind(uploaded.image_url())
    .bind(&uploaded.source)
    .bind(&uploaded.style)
    .bind(&uploaded.seed)
    .bind(&uploaded.renderer_version)
    .bind(uploaded.version)
    .bind(now)
    .bind(account_id)
    .bind(current.version)
    .execute(&mut *transaction)
    .await;
    if updated.is_ok_and(|result| result.rows_affected() == 1) {
        let _ = transaction.commit().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signup_accepts_a_canonical_upload() {
        let uploaded_asset = "data:image/png;base64,iVBORw0KGgo=";
        let avatar = signup_avatar(
            "acct_test",
            "generated_seed",
            Some(&AvatarMutationRequest {
                action: "upload".to_string(),
                uploaded_asset: Some(uploaded_asset.to_string()),
                seed: None,
                expected_version: None,
            }),
            "2026-08-20T00:00:00Z",
        )
        .expect("uploaded signup avatar");

        assert_eq!(avatar.source, "uploaded");
        assert_eq!(avatar.image_url(), uploaded_asset);
        assert_eq!(avatar.version, 2);
    }
}

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

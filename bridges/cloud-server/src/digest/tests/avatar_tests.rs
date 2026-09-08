use super::{input, Source};
use crate::digest::incremental::Changes;

#[test]
fn source_account_avatar_is_optional_and_preserves_canonical_markers() {
    let mut source = input().sources.remove(0);
    let legacy = serde_json::to_value(&source).unwrap();
    assert!(legacy.get("senderAvatarUrl").is_none());
    assert!(serde_json::from_value::<Source>(legacy)
        .unwrap()
        .sender_avatar_url
        .is_none());
    for avatar in [
        "kordi-avatar://uploaded/ava_0123456789abcdef0123456789abcdef",
        "kordi-avatar://test/lorelei/author?version=3",
        "https://example.com/current-avatar.png",
    ] {
        source.sender_avatar_url = Some(avatar.into());
        let serialized = serde_json::to_value(&source).unwrap();
        assert_eq!(serialized["senderAvatarUrl"], avatar);
        assert_eq!(
            serde_json::from_value::<Source>(serialized).unwrap(),
            source
        );
    }
}
#[test]
fn account_avatar_updates_do_not_regenerate_unchanged_evidence() {
    let saved = input();
    let mut current = saved.clone();
    current.sources[0].sender_avatar_url = Some("https://example.com/current.png".into());
    assert!(Changes::between(&saved, &current).is_empty());
    current.sources[0].text = "The draft was updated.".into();
    assert_eq!(Changes::between(&saved, &current).sources.len(), 1);
}

use super::*;

fn cache_test_dir(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "kordi-remote-image-cache-{label}-{}",
        uuid::Uuid::new_v4()
    ))
}

#[test]
fn remote_image_data_urls_are_bounded_and_typed() {
    assert_eq!(
        remote_image_data_url("image/png", b"avatar").expect("encode avatar"),
        "data:image/png;base64,YXZhdGFy"
    );
    assert!(remote_image_data_url("image/png", &[]).is_err());
    assert_eq!(
        supported_image_media_type("image/jpeg; charset=binary"),
        Some("image/jpeg")
    );
    assert_eq!(
        supported_image_media_type("image/vnd.microsoft.icon"),
        Some("image/x-icon")
    );
    assert_eq!(supported_image_media_type("image/svg+xml"), None);
}

#[test]
fn validated_cache_survives_a_new_loader_instance() {
    let cache_dir = cache_test_dir("roundtrip");
    let url = "https://images.example/profile.png";
    let now = 1_750_000_000;
    write_cached_remote_image(
        &cache_dir,
        url,
        "image/png",
        b"avatar",
        now,
        &AVATAR_CACHE_POLICY,
    )
    .expect("write avatar cache");

    let payload = read_cached_remote_image(&cache_dir, url, now + 1, None, &AVATAR_CACHE_POLICY)
        .expect("read avatar after simulated relaunch");
    assert_eq!(payload.media_type, "image/png");
    assert_eq!(payload.bytes, b"avatar");

    let encoded = std::fs::read(remote_image_cache_entry_path(
        &cache_dir,
        url,
        &AVATAR_CACHE_POLICY,
    ))
    .expect("encoded cache entry");
    assert!(
        !String::from_utf8_lossy(&encoded).contains(url),
        "cache metadata must not persist the source URL or query string"
    );
    let _ = std::fs::remove_dir_all(cache_dir);
}

#[test]
fn cache_paths_follow_their_storage_scope() {
    let alpha = remote_image_cache_dir("/app-data/accounts/alpha/kordi", &AVATAR_CACHE_POLICY);
    let beta = remote_image_cache_dir("/app-data/accounts/beta/kordi", &AVATAR_CACHE_POLICY);

    assert_ne!(alpha, beta);
    assert!(alpha.ends_with("accounts/alpha/kordi/cache/remote-avatars-v1"));
    assert!(beta.ends_with("accounts/beta/kordi/cache/remote-avatars-v1"));
    assert!(
        remote_image_cache_dir("/app-data", &BLOB_EMOJI_CACHE_POLICY)
            .ends_with("app-data/cache/blob-emoji-v1")
    );
}

#[test]
fn corrupted_or_expired_cache_entries_are_removed() {
    let cache_dir = cache_test_dir("invalid");
    std::fs::create_dir_all(&cache_dir).expect("create cache directory");
    let corrupt_url = "https://images.example/corrupt.png";
    let corrupt_path = remote_image_cache_entry_path(&cache_dir, corrupt_url, &AVATAR_CACHE_POLICY);
    std::fs::write(&corrupt_path, b"not-a-cache-entry").expect("write corrupt entry");
    assert!(read_cached_remote_image(
        &cache_dir,
        corrupt_url,
        1_750_000_000,
        None,
        &AVATAR_CACHE_POLICY,
    )
    .is_none());
    assert!(!corrupt_path.exists());

    let stale_url = "https://images.example/stale.png";
    write_cached_remote_image(
        &cache_dir,
        stale_url,
        "image/webp",
        b"stale",
        1,
        &AVATAR_CACHE_POLICY,
    )
    .expect("write stale entry");
    let stale_path = remote_image_cache_entry_path(&cache_dir, stale_url, &AVATAR_CACHE_POLICY);
    assert!(read_cached_remote_image(
        &cache_dir,
        stale_url,
        AVATAR_CACHE_POLICY.ttl.expect("avatar TTL").as_secs() + 2,
        None,
        &AVATAR_CACHE_POLICY,
    )
    .is_none());
    assert!(!stale_path.exists());
    let _ = std::fs::remove_dir_all(cache_dir);
}

#[test]
fn disk_cache_pruning_is_explicitly_bounded() {
    let cache_dir = cache_test_dir("bounded");
    std::fs::create_dir_all(&cache_dir).expect("create cache directory");
    for index in 0..5 {
        std::fs::write(
            cache_dir.join(format!("entry-{index}.{}", AVATAR_CACHE_POLICY.extension)),
            vec![index as u8; 16],
        )
        .expect("write cache fixture");
    }
    let abandoned_temporary = cache_dir.join(".abandoned.tmp");
    std::fs::write(&abandoned_temporary, vec![0_u8; 16]).expect("write abandoned cache fixture");

    prune_remote_image_cache(&cache_dir, 2, 32, &AVATAR_CACHE_POLICY).expect("prune avatar cache");
    let entries = std::fs::read_dir(&cache_dir)
        .expect("read cache directory")
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.path().extension().and_then(|value| value.to_str())
                == Some(AVATAR_CACHE_POLICY.extension)
        })
        .count();
    assert_eq!(entries, 2);
    assert!(!abandoned_temporary.exists());
    let _ = std::fs::remove_dir_all(cache_dir);
}

#[test]
fn blob_emoji_cache_is_immutable_and_integrity_checked() {
    let cache_dir = cache_test_dir("blob-emoji");
    let url = "https://images.example/blob.webp";
    let bytes = b"emoji";
    let digest = sha256_hex(bytes);
    write_cached_remote_image(
        &cache_dir,
        url,
        "image/webp",
        bytes,
        1,
        &BLOB_EMOJI_CACHE_POLICY,
    )
    .expect("write Blob Emoji cache");

    let after_one_year = 366 * 24 * 60 * 60;
    assert_eq!(
        read_cached_remote_image(
            &cache_dir,
            url,
            after_one_year,
            Some(&digest),
            &BLOB_EMOJI_CACHE_POLICY,
        )
        .expect("immutable Blob Emoji cache")
        .bytes,
        bytes,
    );
    assert!(read_cached_remote_image(
        &cache_dir,
        url,
        after_one_year,
        Some(&"0".repeat(64)),
        &BLOB_EMOJI_CACHE_POLICY,
    )
    .is_none());
    let _ = std::fs::remove_dir_all(cache_dir);
}

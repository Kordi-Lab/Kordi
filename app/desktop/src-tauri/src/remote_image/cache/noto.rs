use super::*;

// Public Noto assets have their own budgets: animated previews must not evict
// the still catalog, and browsing emoji must not churn account avatar caches.
const NOTO_THUMBNAIL_CACHE_POLICY: RemoteImageCachePolicy = RemoteImageCachePolicy {
    directory: "noto-thumbnails-v1",
    magic: b"KORDI_NOTO_THUMBNAIL_V1\n",
    extension: "png",
    max_entries: 1024,
    max_bytes: 16 * 1024 * 1024,
    ttl: Some(Duration::from_secs(2 * 24 * 60 * 60)),
    required_media_type: Some("image/png"),
    account_scoped: false,
    allow_debug_loopback: false,
};

const NOTO_ANIMATION_CACHE_POLICY: RemoteImageCachePolicy = RemoteImageCachePolicy {
    directory: "noto-previews-v1",
    magic: b"KORDI_NOTO_PREVIEW_V1\n",
    extension: "image",
    max_entries: 192,
    max_bytes: 64 * 1024 * 1024,
    required_media_type: None,
    ..NOTO_THUMBNAIL_CACHE_POLICY
};

pub(in crate::remote_image) fn noto_cache_policy(
    url: &str,
) -> Option<&'static RemoteImageCachePolicy> {
    let asset = url.strip_prefix("https://fonts.gstatic.com/s/e/notoemoji/latest/")?;
    let (id, file) = asset.split_once('/')?;
    if !id
        .split('_')
        .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_hexdigit()))
    {
        return None;
    }
    match file {
        "128.png" => Some(&NOTO_THUMBNAIL_CACHE_POLICY),
        "512.png" | "512.webp" | "512.gif" => Some(&NOTO_ANIMATION_CACHE_POLICY),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_public_noto_assets_use_the_shared_emoji_caches() {
        let thumbnail =
            noto_cache_policy("https://fonts.gstatic.com/s/e/notoemoji/latest/1f602/128.png")
                .unwrap();
        let animation =
            noto_cache_policy("https://fonts.gstatic.com/s/e/notoemoji/latest/1f602/512.webp")
                .unwrap();
        assert_ne!(thumbnail.directory, animation.directory);
        assert_ne!(thumbnail.directory, AVATAR_CACHE_POLICY.directory);
        assert!(!thumbnail.account_scoped);
        assert!(thumbnail.max_entries >= 881);
        for url in [
            "https://example.com/s/e/notoemoji/latest/1f602/128.png",
            "https://fonts.gstatic.com/s/e/notoemoji/latest/1f602/128.png?account=private",
            "https://fonts.gstatic.com/s/e/notoemoji/latest/../128.png",
            "https://fonts.gstatic.com/s/e/notoemoji/latest/1f602/64.png",
        ] {
            assert!(noto_cache_policy(url).is_none());
        }
    }

    #[test]
    fn browsing_more_than_the_avatar_limit_retains_the_first_thumbnail() {
        let cache_dir =
            std::env::temp_dir().join(format!("kordi-noto-cache-{}", uuid::Uuid::new_v4()));
        let url = "https://fonts.gstatic.com/s/e/notoemoji/latest/1f602/128.png";
        let policy = noto_cache_policy(url).unwrap();
        let now = unix_timestamp_seconds();
        write_cached_remote_image(&cache_dir, url, "image/png", b"thumbnail", now, policy).unwrap();
        for index in 0..140 {
            let other = format!("https://fonts.gstatic.com/s/e/notoemoji/latest/{index:x}/128.png");
            write_cached_remote_image(&cache_dir, &other, "image/png", b"thumbnail", now, policy)
                .unwrap();
        }
        assert!(read_cached_remote_image(&cache_dir, url, now + 1, None, policy).is_some());
        assert!(
            read_cached_remote_image(&cache_dir, url, now + 3 * 24 * 60 * 60, None, policy)
                .is_none()
        );
        std::fs::remove_dir_all(cache_dir).unwrap();
    }
}

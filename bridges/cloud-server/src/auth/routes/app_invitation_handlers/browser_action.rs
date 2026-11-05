use crate::web_pages::WebPagesDir;

/// Offer the browser action only when the configured same-origin app entry
/// is a file the static server may serve, including its symlink and size guards.
pub(in crate::auth::routes) async fn configured_browser_group_invitation_url(
    token: &str,
) -> Option<String> {
    let pages = WebPagesDir::from_env().ok().flatten()?;
    browser_group_invitation_url(token, &pages).await
}

async fn browser_group_invitation_url(token: &str, pages: &WebPagesDir) -> Option<String> {
    if token.is_empty() {
        return None;
    }
    let entry = tokio::fs::canonicalize(pages.root().join("app/index.html"))
        .await
        .ok()?;
    if !entry.starts_with(pages.root()) {
        return None;
    }
    let metadata = tokio::fs::metadata(entry).await.ok()?;
    if !metadata.is_file() || metadata.len() > 16 * 1024 * 1024 {
        return None;
    }
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("groupInvite", token)
        .finish();
    Some(format!("/app?{query}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn browser_invitation_requires_a_served_app_and_encodes_its_token() {
        let root = std::env::temp_dir().join(format!("kordi-web-invite-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("app")).unwrap();
        let pages = WebPagesDir::open(&root).unwrap();
        assert!(browser_group_invitation_url("kordi_gi_fixture", &pages)
            .await
            .is_none());
        std::fs::write(
            root.join("app/index.html"),
            "<!doctype html><title>Fixture</title>",
        )
        .unwrap();
        let token = "kordi_gi_fixture&next=//elsewhere.example\"";
        let target = browser_group_invitation_url(token, &pages).await.unwrap();
        let parsed = url::Url::parse(&format!("https://fixture.example{target}")).unwrap();
        assert_eq!(parsed.path(), "/app");
        assert_eq!(
            parsed.query_pairs().into_owned().collect::<Vec<_>>(),
            vec![("groupInvite".to_string(), token.to_string())]
        );
        assert!(browser_group_invitation_url("", &pages).await.is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn browser_invitation_never_offers_an_app_symlink_outside_the_pages_root() {
        let root = std::env::temp_dir().join(format!("kordi-web-invite-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("pages/app")).unwrap();
        std::fs::write(root.join("outside.html"), "<!doctype html>").unwrap();
        std::os::unix::fs::symlink(root.join("outside.html"), root.join("pages/app/index.html"))
            .unwrap();
        let pages = WebPagesDir::open(&root.join("pages")).unwrap();
        assert!(browser_group_invitation_url("kordi_gi_fixture", &pages)
            .await
            .is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
}

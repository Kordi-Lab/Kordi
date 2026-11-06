use crate::web_pages::WebPagesDir;

/// Where invitation pages send people who continue on the web.
pub(in crate::auth::routes) const BROWSER_APP_PATH: &str = "/app/";

/// The browser application's path when this server serves it, including the
/// static server's symlink and size guards. Pages offer "Continue on the
/// web" only then.
pub(in crate::auth::routes) async fn configured_browser_app_url() -> Option<&'static str> {
    let pages = WebPagesDir::from_env().ok().flatten()?;
    browser_app_url(&pages).await
}

async fn browser_app_url(pages: &WebPagesDir) -> Option<&'static str> {
    let entry = tokio::fs::canonicalize(pages.root().join("app/index.html"))
        .await
        .ok()?;
    if !entry.starts_with(pages.root()) {
        return None;
    }
    let metadata = tokio::fs::metadata(entry).await.ok()?;
    (metadata.is_file() && metadata.len() <= 16 * 1024 * 1024).then_some(BROWSER_APP_PATH)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn browser_app_is_offered_only_when_it_is_served() {
        let root = std::env::temp_dir().join(format!("kordi-web-invite-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("app")).unwrap();
        let pages = WebPagesDir::open(&root).unwrap();
        assert!(browser_app_url(&pages).await.is_none());
        std::fs::write(
            root.join("app/index.html"),
            "<!doctype html><title>Fixture</title>",
        )
        .unwrap();
        assert_eq!(browser_app_url(&pages).await, Some("/app/"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn browser_app_is_never_offered_through_a_symlink_outside_the_pages_root() {
        let root = std::env::temp_dir().join(format!("kordi-web-invite-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("pages/app")).unwrap();
        std::fs::write(root.join("outside.html"), "<!doctype html>").unwrap();
        std::os::unix::fs::symlink(root.join("outside.html"), root.join("pages/app/index.html"))
            .unwrap();
        let pages = WebPagesDir::open(&root.join("pages")).unwrap();
        assert!(browser_app_url(&pages).await.is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
}

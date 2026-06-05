use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;

const DESKTOP_UPDATE_MANIFEST_JSON_ENV: &str = "KORDI_DESKTOP_UPDATE_MANIFEST_JSON";

pub fn routes() -> Router {
    Router::new().route(
        "/api/desktop-updates/:target/:arch/:current_version",
        get(desktop_update_manifest),
    )
}

async fn desktop_update_manifest() -> Response {
    desktop_update_manifest_response(std::env::var(DESKTOP_UPDATE_MANIFEST_JSON_ENV).ok())
}

fn desktop_update_manifest_response(raw_manifest: Option<String>) -> Response {
    let Some(raw_manifest) = raw_manifest else {
        return StatusCode::NO_CONTENT.into_response();
    };
    let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&raw_manifest) else {
        return StatusCode::NO_CONTENT.into_response();
    };
    axum::Json(manifest).into_response()
}

#[cfg(test)]
mod tests {
    use super::desktop_update_manifest_response;
    use axum::body::to_bytes;
    use axum::http::StatusCode;

    #[tokio::test]
    async fn desktop_update_manifest_is_quiet_when_no_manifest_is_configured() {
        let response = desktop_update_manifest_response(None);

        assert_eq!(response.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn desktop_update_manifest_serves_release_metadata_json() {
        let response = desktop_update_manifest_response(Some(
            serde_json::json!({
                "version": "0.0.1-beta.4",
                "notes": "Bug fixes",
                "pub_date": "2026-06-04T00:00:00Z",
                "url": "https://coordinar.io/downloads/Kordi_0.0.1-beta.4_aarch64.app.tar.gz",
                "signature": "signed-release"
            })
            .to_string(),
        ));

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let manifest: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(manifest["version"], "0.0.1-beta.4");
        assert_eq!(manifest["signature"], "signed-release");
    }
}

use tauri::Manager;

const MEDIA_PREVIEW_WINDOW_LABEL: &str = "media-preview";

fn is_valid_media_preview_request_id(request_id: &str) -> bool {
    !request_id.is_empty()
        && request_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
}

fn media_preview_url_matches_request(url: &tauri::Url, request_id: &str) -> bool {
    url.query_pairs()
        .any(|(key, value)| key == "mediaPreviewRequest" && value == request_id)
}

#[tauri::command]
pub(crate) async fn desktop_open_media_preview_window(
    app: tauri::AppHandle,
    request_id: String,
    title: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    if !is_valid_media_preview_request_id(&request_id) {
        return Err("Invalid media preview request".to_string());
    }
    if payload.get("requestId").and_then(serde_json::Value::as_str) != Some(request_id.as_str()) {
        return Err("Media preview payload does not match its request".to_string());
    }
    if let Some(existing) = app.get_webview_window(MEDIA_PREVIEW_WINDOW_LABEL) {
        existing.destroy().map_err(|error| error.to_string())?;
    }

    let media_path = format!("index.html?mediaPreview=1&mediaPreviewRequest={request_id}");
    let serialized_payload = serde_json::to_string(&payload).map_err(|error| error.to_string())?;
    let initialization_script =
        format!("window.__KORDI_ATTACHMENT_MEDIA_PAYLOAD__ = {serialized_payload};");
    let builder = tauri::WebviewWindowBuilder::new(
        &app,
        MEDIA_PREVIEW_WINDOW_LABEL,
        tauri::WebviewUrl::App(media_path.into()),
    )
    .title(if title.trim().is_empty() {
        "Kordi Media"
    } else {
        title.trim()
    })
    .initialization_script(&initialization_script)
    .inner_size(1080.0, 760.0)
    .min_inner_size(520.0, 360.0)
    .center()
    .resizable(true)
    .minimizable(true)
    .maximizable(true)
    .closable(true)
    .decorations(true)
    .shadow(true)
    .visible(false)
    .transparent(true)
    .background_color(tauri::utils::config::Color(0, 0, 0, 0));

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .effects(tauri::utils::config::WindowEffectsConfig {
            effects: vec![tauri::window::Effect::UnderWindowBackground],
            state: Some(tauri::window::EffectState::FollowsWindowActiveState),
            radius: Some(12.0),
            color: None,
        });

    builder.build().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn desktop_reveal_media_preview_window(
    app: tauri::AppHandle,
    request_id: String,
) -> Result<(), String> {
    if !is_valid_media_preview_request_id(&request_id) {
        return Err("Invalid media preview request".to_string());
    }
    let window = app
        .get_webview_window(MEDIA_PREVIEW_WINDOW_LABEL)
        .ok_or_else(|| "Media preview window is unavailable".to_string())?;
    let window_url = window.url().map_err(|error| error.to_string())?;
    if !media_preview_url_matches_request(&window_url, &request_id) {
        return Err("Media preview request does not match the current window".to_string());
    }
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{is_valid_media_preview_request_id, media_preview_url_matches_request};

    #[test]
    fn request_ids_allow_only_local_generated_tokens() {
        assert!(is_valid_media_preview_request_id(
            "4d216ab0-480b-4f5a-ae54-4c69c13c33b3"
        ));
        assert!(!is_valid_media_preview_request_id(""));
        assert!(!is_valid_media_preview_request_id("https://example.com"));
        assert!(!is_valid_media_preview_request_id("../index.html"));
    }

    #[test]
    fn reveal_matches_only_the_current_window_request() {
        let current = tauri::Url::parse(
            "tauri://localhost/index.html?mediaPreview=1&mediaPreviewRequest=request-current",
        )
        .expect("media preview URL should parse");

        assert!(media_preview_url_matches_request(
            &current,
            "request-current"
        ));
        assert!(!media_preview_url_matches_request(
            &current,
            "request-stale"
        ));
    }
}

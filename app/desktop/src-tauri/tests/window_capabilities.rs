use serde_json::json;
use tauri::{
    ipc::{CallbackFn, InvokeBody},
    test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY},
    webview::InvokeRequest,
    WebviewWindow,
};

fn invoke(
    window: &WebviewWindow<MockRuntime>,
    command: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    get_ipc_response(
        window,
        InvokeRequest {
            cmd: command.to_string(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|response| response.deserialize().unwrap_or(serde_json::Value::Null))
    .map_err(|error| error.to_string())
}

fn create_webview_request(label: &str) -> serde_json::Value {
    json!({
        "options": {
            "label": label,
            "url": "index.html",
        }
    })
}

fn is_permission_denial(error: &str) -> bool {
    error.contains("not allowed")
}

#[test]
fn only_the_main_window_can_open_new_windows() {
    let app = mock_builder()
        .build(tauri::generate_context!())
        .expect("build desktop with its real capabilities");
    let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    for label in ["auth-popup", "media-preview", "call"] {
        let window = tauri::WebviewWindowBuilder::new(&app, label, Default::default())
            .build()
            .unwrap();
        let denied = invoke(
            &window,
            "plugin:webview|create_webview_window",
            create_webview_request(&format!("{label}-child")),
        )
        .expect_err("secondary windows cannot create windows");
        assert!(is_permission_denial(&denied), "{label}: {denied}");

        // Shared window controls stay available to every window.
        let hidden = invoke(&window, "plugin:window|hide", json!({ "label": label }));
        assert!(
            hidden
                .as_ref()
                .err()
                .is_none_or(|error| !is_permission_denial(error)),
            "{label} should keep window controls: {hidden:?}"
        );
    }

    let created = invoke(
        &main,
        "plugin:webview|create_webview_window",
        create_webview_request("call"),
    );
    assert!(
        created
            .as_ref()
            .err()
            .is_none_or(|error| !is_permission_denial(error)),
        "main window must keep window creation: {created:?}"
    );
}

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
) -> Result<serde_json::Value, serde_json::Value> {
    get_ipc_response(
        window,
        InvokeRequest {
            cmd: format!("plugin:http|{command}"),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|response| response.deserialize().unwrap())
}

#[test]
fn cloud_http_capability_accepts_only_supported_kordi_origins() {
    let app = mock_builder()
        .plugin(tauri_plugin_http::init())
        .build(tauri::generate_context!())
        .expect("build desktop with its real capabilities");
    let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    for (url, allowed) in [
        ("https://kordi.ai/v1/cloud/auth/capabilities", true),
        ("http://127.0.0.1:17081/v1/cloud/auth/capabilities", true),
        ("http://127.0.0.1:18181/v1/cloud/auth/capabilities", true),
        ("http://127.0.0.1:17082/v1/cloud/auth/capabilities", false),
        ("http://localhost:17081/v1/cloud/auth/capabilities", false),
        ("http://[::1]:17081/v1/cloud/auth/capabilities", false),
        ("https://127.0.0.1:17081/v1/cloud/auth/capabilities", false),
        ("https://localhost:17081/v1/cloud/auth/capabilities", false),
        ("https://[::1]:17081/v1/cloud/auth/capabilities", false),
        ("http://kordi.ai/v1/cloud/auth/capabilities", false),
        ("https://example.com/v1/cloud/auth/capabilities", false),
        (
            "http://127.0.0.1.example.com:17081/v1/cloud/auth/capabilities",
            false,
        ),
    ] {
        // fetch constructs the scoped request; fetch_send is deliberately never
        // invoked, so the test cannot contact any of these destinations.
        let response = invoke(
            &window,
            "fetch",
            json!({ "clientConfig": {
                "method": "GET", "url": url, "headers": [], "data": null,
            }}),
        );
        assert_eq!(
            response.is_ok(),
            allowed,
            "scope result for {url}: {response:?}"
        );
        if let Ok(rid) = response {
            invoke(&window, "fetch_cancel", json!({ "rid": rid })).unwrap();
        }
    }
}

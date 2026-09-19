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
fn cloud_http_capability_accepts_product_and_loopback_requests_only() {
    let app = mock_builder()
        .plugin(tauri_plugin_http::init())
        .build(tauri::generate_context!())
        .expect("build desktop with its real capabilities");
    let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    for (url, allowed) in [
        ("https://kordi.ai/v1/cloud/auth/capabilities", true),
        ("http://127.0.0.1:17083/v1/cloud/auth/capabilities", true),
        ("http://localhost:17083/v1/cloud/auth/capabilities", true),
        ("http://[::1]:17083/v1/cloud/auth/capabilities", true),
        ("https://127.0.0.1:17083/v1/cloud/auth/capabilities", true),
        ("https://localhost:17083/v1/cloud/auth/capabilities", true),
        ("https://[::1]:17083/v1/cloud/auth/capabilities", true),
        ("https://example.com/v1/cloud/auth/capabilities", false),
        (
            "http://127.0.0.1.example.com:17083/v1/cloud/auth/capabilities",
            false,
        ),
        ("http://[::2]:17083/v1/cloud/auth/capabilities", false),
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

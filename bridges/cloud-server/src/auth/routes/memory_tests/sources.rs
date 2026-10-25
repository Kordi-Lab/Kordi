//! Every memory source the server accepts, including `digest` (#2053) and
//! `import` (#2054).

use super::*;

#[tokio::test]
async fn memory_sources_include_digest_and_import() {
    let Some(fx) = fixture().await else { return };
    let mut saved = Vec::new();
    for (source, declaration) in [
        ("user_correction", "model-inferred"),
        ("repeated_failure", "model-inferred"),
        ("outcome", "model-inferred"),
        ("manual", "user-declared"),
        ("digest", "model-inferred"),
        ("import", "user-declared"),
    ] {
        let mut body = memory_body(&format!("A memory from {source}"));
        body["source"] = json!(source);
        let (status, created) = fx.send("POST", "/v1/cloud/memory", Some(body)).await;
        assert_eq!(status, StatusCode::CREATED, "{source}: {created}");
        assert_eq!(created["memory"]["source"], source);
        assert_eq!(
            created["memory"]["declarationType"], declaration,
            "{source}"
        );
        saved.push(created["memory"]["memoryId"].as_str().unwrap().to_owned());
    }
    // Memories with the new sources can be edited like any other.
    for memory_id in &saved[4..] {
        let (status, edited) = fx
            .send(
                "PATCH",
                &format!("/v1/cloud/memory/{memory_id}"),
                Some(json!({"text": format!("Edited {memory_id}"), "category": "work_context"})),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{edited}");
        assert_eq!(edited["memory"]["category"], "work_context");
    }
    let mut unknown = memory_body("Anything");
    unknown["source"] = json!("guess");
    let (status, error) = fx.send("POST", "/v1/cloud/memory", Some(unknown)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["errorCode"], "invalid_source");
    fx.cleanup().await;
}

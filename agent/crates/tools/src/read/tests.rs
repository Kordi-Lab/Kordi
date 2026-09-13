#[path = "../../../provider/tests/support/images.rs"]
mod image_fixtures;
use super::*;
use kordi_core::types::ContentBlock;
use std::path::Path;
use tokio_util::sync::CancellationToken;

fn make_ctx(dir: &Path) -> ToolContext {
    ToolContext {
        cwd: dir.to_path_buf(),
        artifacts_dir: dir.to_path_buf(),
        model: None,
        execution_policy: crate::ExecutionPolicy::Safety,
        on_output: None,
        web_search: None,
        reach_out: None,
        reflection: None,
        session_observation: None,
        task_operator: None,
        schedule_task: None,
        execution_mode: crate::ToolExecutionMode::Interactive,
        request_approval: None,
    }
}

#[test]
fn safe_char_boundary_never_splits_multibyte_characters() {
    let text = format!("{}─tail", "x".repeat(99));
    let cut = safe_char_boundary_at_or_before(&text, 100);
    assert!(text.is_char_boundary(cut));
    assert_eq!(&text[..cut], &"x".repeat(99));
}

#[tokio::test]
async fn read_simple_file() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("hello.txt");
    std::fs::write(&file, "line1\nline2\nline3\n").unwrap();

    let tool = ReadTool;
    let ctx = make_ctx(dir.path());
    let result = tool
        .execute(
            serde_json::json!({ "path": "hello.txt" }),
            &ctx,
            CancellationToken::new(),
        )
        .await
        .unwrap();

    assert!(!result.is_error);
    let text = match &result.content[0] {
        ContentBlock::Text { text } => text.clone(),
        _ => panic!("expected text"),
    };
    assert!(text.contains("line1"));
    assert!(text.contains("line2"));
    assert!(text.contains("line3"));
}

#[tokio::test]
async fn read_with_offset_and_limit() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("nums.txt");
    let content: String = (1..=10).map(|i| format!("line{i}\n")).collect();
    std::fs::write(&file, &content).unwrap();

    let tool = ReadTool;
    let ctx = make_ctx(dir.path());
    let result = tool
        .execute(
            serde_json::json!({ "path": "nums.txt", "offset": 3, "limit": 2 }),
            &ctx,
            CancellationToken::new(),
        )
        .await
        .unwrap();

    let text = match &result.content[0] {
        ContentBlock::Text { text } => text.clone(),
        _ => panic!("expected text"),
    };
    assert!(text.contains("line3"));
    assert!(text.contains("line4"));
    assert!(!text.contains("line2"));
    assert!(!text.contains("line5"));
}

#[tokio::test]
async fn read_offset_past_end() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("short.txt");
    std::fs::write(&file, "only\n").unwrap();

    let tool = ReadTool;
    let ctx = make_ctx(dir.path());
    let result = tool
        .execute(
            serde_json::json!({ "path": "short.txt", "offset": 999 }),
            &ctx,
            CancellationToken::new(),
        )
        .await
        .unwrap();

    assert!(result.is_error);
    let text = match &result.content[0] {
        ContentBlock::Text { text } => text.clone(),
        _ => panic!("expected text"),
    };
    assert!(text.contains("past end"));
}

#[tokio::test]
async fn read_file_not_found() {
    let dir = tempfile::tempdir().unwrap();
    let tool = ReadTool;
    let ctx = make_ctx(dir.path());
    let err = tool
        .execute(
            serde_json::json!({ "path": "nope.txt" }),
            &ctx,
            CancellationToken::new(),
        )
        .await;
    assert!(err.is_err());
}

#[tokio::test]
async fn read_truncates_large_file() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("big.txt");
    let content: String = (1..=3000).map(|i| format!("line {i}\n")).collect();
    std::fs::write(&file, &content).unwrap();

    let tool = ReadTool;
    let ctx = make_ctx(dir.path());
    let result = tool
        .execute(
            serde_json::json!({ "path": "big.txt" }),
            &ctx,
            CancellationToken::new(),
        )
        .await
        .unwrap();

    let text = match &result.content[0] {
        ContentBlock::Text { text } => text.clone(),
        _ => panic!("expected text"),
    };
    assert!(text.contains("more lines in file"));
    assert!(!text.contains("line 3000"));
}

#[tokio::test]
async fn read_truncates_by_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("wide.txt");
    let content: String = (1..=500).map(|i| format!("{:0>200}\n", i)).collect();
    std::fs::write(&file, &content).unwrap();

    let tool = ReadTool;
    let ctx = make_ctx(dir.path());
    let result = tool
        .execute(
            serde_json::json!({ "path": "wide.txt" }),
            &ctx,
            CancellationToken::new(),
        )
        .await
        .unwrap();

    let text = match &result.content[0] {
        ContentBlock::Text { text } => text.clone(),
        _ => panic!("expected text"),
    };
    let full_len: usize = (1..=500)
        .map(|i| format!("{:0>200}", i).len() + 1)
        .sum::<usize>();
    assert!(
        text.len() < full_len,
        "output should be truncated by byte limit"
    );
}

#[tokio::test]
async fn read_utf8_content() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("utf8.txt");
    std::fs::write(&file, "γειά κόσμε\nこんにちは\n🎉🎉🎉\n").unwrap();

    let tool = ReadTool;
    let ctx = make_ctx(dir.path());
    let result = tool
        .execute(
            serde_json::json!({ "path": "utf8.txt" }),
            &ctx,
            CancellationToken::new(),
        )
        .await
        .unwrap();

    assert!(!result.is_error);
    let text = match &result.content[0] {
        ContentBlock::Text { text } => text.clone(),
        _ => panic!("expected text"),
    };
    assert!(text.contains("γειά κόσμε"));
    assert!(text.contains("こんにちは"));
    assert!(text.contains("🎉🎉🎉"));
}

#[tokio::test]
async fn read_image_returns_base64() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("test.png");
    let png_bytes = image_fixtures::RED_BLUE;
    std::fs::write(&file, png_bytes).unwrap();

    let tool = ReadTool;
    let ctx = make_ctx(dir.path());
    let result = tool
        .execute(
            serde_json::json!({ "path": "test.png" }),
            &ctx,
            CancellationToken::new(),
        )
        .await
        .unwrap();

    assert!(!result.is_error);
    match &result.content[0] {
        ContentBlock::Image { data, mime_type } => {
            assert_eq!(mime_type, "image/png");
            assert!(!data.is_empty());
        }
        _ => panic!("expected image content block"),
    }
}

#[tokio::test]
async fn image_reads_check_actual_format_and_reject_corrupt_or_oversized_files() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = make_ctx(dir.path());
    std::fs::write(
        dir.path().join("wrong-extension.jpg"),
        image_fixtures::GREEN_WHITE,
    )
    .unwrap();
    let result = ReadTool
        .execute(
            json!({"path":"wrong-extension.jpg"}),
            &ctx,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(
        matches!(&result.content[0], ContentBlock::Image { mime_type, .. } if mime_type == "image/png")
    );
    std::fs::write(
        dir.path().join("corrupt.png"),
        &image_fixtures::RED_BLUE[..32],
    )
    .unwrap();
    let error = ReadTool
        .execute(
            json!({"path":"corrupt.png"}),
            &ctx,
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("corrupt"));
    let file = std::fs::File::create(dir.path().join("large.png")).unwrap();
    file.set_len(crate::image_input::MAX_IMAGE_BYTES as u64 + 1)
        .unwrap();
    let error = ReadTool
        .execute(json!({"path":"large.png"}), &ctx, CancellationToken::new())
        .await
        .unwrap_err();
    assert!(error.to_string().contains("4 MiB"));

    let mut encoded = std::io::Cursor::new(Vec::new());
    ::image::DynamicImage::new_rgb8(8193, 1)
        .write_to(&mut encoded, ::image::ImageFormat::Png)
        .unwrap();
    assert!(
        crate::image_input::image_content(encoded.get_ref())
            .unwrap_err()
            .to_string()
            .contains("decoding limits")
    );
}

#[tokio::test]
async fn read_absolute_path() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("abs.txt");
    std::fs::write(&file, "absolute content\n").unwrap();

    let tool = ReadTool;
    let ctx = make_ctx(dir.path());
    let result = tool
        .execute(
            serde_json::json!({ "path": file.to_str().unwrap() }),
            &ctx,
            CancellationToken::new(),
        )
        .await
        .unwrap();

    assert!(!result.is_error);
    let text = match &result.content[0] {
        ContentBlock::Text { text } => text.clone(),
        _ => panic!("expected text"),
    };
    assert!(text.contains("absolute content"));
}

#[tokio::test]
async fn read_strips_at_prefix() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("at.txt");
    std::fs::write(&file, "at content\n").unwrap();

    let tool = ReadTool;
    let ctx = make_ctx(dir.path());
    let result = tool
        .execute(
            serde_json::json!({ "path": "@at.txt" }),
            &ctx,
            CancellationToken::new(),
        )
        .await
        .unwrap();

    assert!(!result.is_error);
    let text = match &result.content[0] {
        ContentBlock::Text { text } => text.clone(),
        _ => panic!("expected text"),
    };
    assert!(text.contains("at content"));
}

#[tokio::test]
async fn read_returns_correct_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("meta.txt");
    std::fs::write(&file, "a\nb\nc\nd\ne\n").unwrap();

    let tool = ReadTool;
    let ctx = make_ctx(dir.path());
    let result = tool
        .execute(
            serde_json::json!({ "path": "meta.txt", "offset": 2, "limit": 2 }),
            &ctx,
            CancellationToken::new(),
        )
        .await
        .unwrap();

    let details = result.details.unwrap();
    assert_eq!(details["totalLines"], 5);
    assert_eq!(details["startLine"], 2);
    assert_eq!(details["endLine"], 3);
}

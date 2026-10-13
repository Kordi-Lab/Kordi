//! Applying `edit_document` operations: replace, insert_after, delete,
//! unknown blocks, and the limits.

use serde_json::json;

use crate::document_shares::agents::operations::{
    apply_operations, Operation, OperationError, OperationKind,
};
use crate::document_shares::agents::{MAX_EDIT_OPERATIONS, MAX_TOOL_TEXT_BYTES};
use crate::document_shares::render::markdown_blocks;

fn op(kind: OperationKind, block_id: &str, markdown: Option<&str>) -> Operation {
    Operation {
        op: kind,
        block_id: block_id.to_string(),
        markdown: markdown.map(str::to_string),
    }
}

fn apply(source: &str, operations: &[Operation]) -> Result<(String, Vec<String>), OperationError> {
    let mut next = 0;
    let mut new_id = || {
        next += 1;
        format!("k:new{next:04}")
    };
    apply_operations(source, operations, &mut new_id)
        .map(|applied| (applied.text, applied.new_block_ids))
}

fn ids_and_sources(text: &str) -> Vec<(String, String)> {
    markdown_blocks(text)
        .into_iter()
        .map(|block| (block.id, block.source))
        .collect()
}

const STAMPED: &str = "# Plan <!-- k:head0001 -->\n\nFirst.\n\n[ref]: https://example.com\n\n```\ncode\n```\n<!-- k:code0001 -->\n\nLast.\n";

#[test]
fn replace_keeps_ids_and_untouched_bytes() {
    let (text, new_ids) = apply(
        STAMPED,
        &[op(
            OperationKind::Replace,
            "k:code0001",
            Some("```\nbetter\n```"),
        )],
    )
    .unwrap();
    assert_eq!(
        text,
        "# Plan <!-- k:head0001 -->\n\nFirst.\n\n[ref]: https://example.com\n\n```\nbetter\n```\n<!-- k:code0001 -->\n\nLast.\n"
    );
    assert!(new_ids.is_empty());

    // A block with only an index id gets a stable id, and the map says so.
    let mut next = 0;
    let mut new_id = || {
        next += 1;
        format!("k:new{next:04}")
    };
    let applied = apply_operations(
        STAMPED,
        &[op(OperationKind::Replace, "b1", Some("First, revised."))],
        &mut new_id,
    )
    .unwrap();
    assert_eq!(
        ids_and_sources(&applied.text),
        [
            ("k:head0001".to_string(), "# Plan".to_string()),
            ("k:new0001".to_string(), "First, revised.".to_string()),
            ("k:code0001".to_string(), "```\ncode\n```".to_string()),
            ("b3".to_string(), "Last.".to_string()),
        ]
    );
    assert_eq!(
        applied.stamped.get("b1").map(String::as_str),
        Some("k:new0001")
    );
    assert!(applied.text.contains("[ref]: https://example.com"));

    // Replacing with two blocks keeps the id on the first and stamps the second.
    let (text, new_ids) = apply(
        STAMPED,
        &[op(
            OperationKind::Replace,
            "k:head0001",
            Some("# Plan B\n\nIntro. <!-- k:code0001 -->"),
        )],
    )
    .unwrap();
    let blocks = ids_and_sources(&text);
    assert_eq!(
        blocks[0],
        ("k:head0001".to_string(), "# Plan B".to_string())
    );
    assert_eq!(blocks[1], ("k:new0001".to_string(), "Intro.".to_string()));
    assert_eq!(new_ids, ["k:new0001"]);
    assert_eq!(
        blocks[3].0, "k:code0001",
        "a written id comment claims nothing"
    );
}

#[test]
fn insert_after_and_delete_address_blocks_of_the_base_revision() {
    let (text, new_ids) = apply(
        STAMPED,
        &[
            op(OperationKind::InsertAfter, "k:head0001", Some("Intro.")),
            op(OperationKind::Delete, "b1", None),
            op(
                OperationKind::InsertAfter,
                "b3",
                Some("- one\n- two\n\nEnd."),
            ),
        ],
    )
    .unwrap();
    assert_eq!(
        ids_and_sources(&text),
        [
            ("k:head0001".to_string(), "# Plan".to_string()),
            ("k:new0001".to_string(), "Intro.".to_string()),
            ("k:code0001".to_string(), "```\ncode\n```".to_string()),
            ("b3".to_string(), "Last.".to_string()),
            ("k:new0002".to_string(), "- one\n- two".to_string()),
            ("k:new0003".to_string(), "End.".to_string()),
        ]
    );
    assert_eq!(new_ids, ["k:new0001", "k:new0002", "k:new0003"]);
    assert!(text.contains("[ref]: https://example.com"));
    assert!(
        !text.contains("\n\n\n"),
        "a deleted block leaves one blank line"
    );
    assert!(text.ends_with("End.\n<!-- k:new0003 -->\n"));

    // Deleting every block leaves an empty document.
    let (text, _) = apply(
        "One.\n\nTwo.\n",
        &[
            op(OperationKind::Delete, "b0", None),
            op(OperationKind::Delete, "b1", None),
        ],
    )
    .unwrap();
    assert_eq!(text, "\n");
    // Inserting after a block deleted in the same call keeps the insert.
    let (text, _) = apply(
        "One.\n\nTwo.\n",
        &[
            op(OperationKind::InsertAfter, "b0", Some("New.")),
            op(OperationKind::Delete, "b0", None),
        ],
    )
    .unwrap();
    assert_eq!(text, "New.\n<!-- k:new0001 -->\n\nTwo.\n");
}

#[test]
fn bad_operations_are_refused_whole() {
    assert_eq!(
        apply(STAMPED, &[op(OperationKind::Delete, "b9", None)]),
        Err(OperationError::UnknownBlock("b9".to_string()))
    );
    assert_eq!(
        apply(
            STAMPED,
            &[
                op(OperationKind::Delete, "b1", None),
                op(OperationKind::Replace, "b1", Some("Again.")),
            ]
        ),
        Err(OperationError::UnknownBlock("b1".to_string()))
    );
    for markdown in [None, Some("  \n"), Some("<!-- k:head0001 -->")] {
        assert_eq!(
            apply(STAMPED, &[op(OperationKind::Replace, "b1", markdown)]),
            Err(OperationError::MissingMarkdown("b1".to_string())),
            "{markdown:?}"
        );
    }
    assert_eq!(apply(STAMPED, &[]), Err(OperationError::Count));
    let many: Vec<Operation> = (0..=MAX_EDIT_OPERATIONS)
        .map(|_| op(OperationKind::InsertAfter, "b1", Some("x")))
        .collect();
    assert_eq!(apply(STAMPED, &many), Err(OperationError::Count));
    assert!(apply(STAMPED, &many[..MAX_EDIT_OPERATIONS]).is_ok());
    let large = "x".repeat(MAX_TOOL_TEXT_BYTES / 2 + 1);
    assert_eq!(
        apply(
            STAMPED,
            &[
                op(OperationKind::Replace, "b1", Some(&large)),
                op(OperationKind::InsertAfter, "b1", Some(&large)),
            ]
        ),
        Err(OperationError::TooLarge)
    );
    for error in [
        OperationError::Count,
        OperationError::TooLarge,
        OperationError::UnknownBlock("b9".into()),
        OperationError::MissingMarkdown("b1".into()),
    ] {
        assert!(!error.message().is_empty());
    }
    // Operations parse from the wire shape.
    let parsed: Vec<Operation> = serde_json::from_value(json!([
        { "op": "replace", "blockId": "b1", "markdown": "New." },
        { "op": "insert_after", "blockId": "b1", "markdown": "More." },
        { "op": "delete", "blockId": "b2" }
    ]))
    .unwrap();
    assert_eq!(parsed[1].op, OperationKind::InsertAfter);
    assert_eq!(parsed[2].markdown, None);
    assert!(serde_json::from_value::<Operation>(json!({ "op": "move", "blockId": "b1" })).is_err());
}

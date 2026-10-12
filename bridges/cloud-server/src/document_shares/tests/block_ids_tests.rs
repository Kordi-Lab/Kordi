//! Pure tests for stable block ids.

use std::collections::HashMap;

use super::super::block_ids::{annotation_targets, is_stable_block_id, split_block_id};
use super::super::model::DocumentBlock;
use super::super::render::markdown_blocks;
use super::super::validate::is_valid_block_id;

fn ids(source: &str) -> Vec<String> {
    markdown_blocks(source)
        .into_iter()
        .map(|block| block.id)
        .collect()
}

#[test]
fn trailing_comments_become_stable_ids_and_leave_no_trace() {
    let blocks = markdown_blocks(
        "# Plan <!-- k:title01 -->\n\nFirst line\nlast line <!-- k:para_02 -->   \n\n- one\n- two <!-- k:list-03 -->\n",
    );
    let found: Vec<(&str, &str, &str)> = blocks
        .iter()
        .map(|block| {
            (
                block.id.as_str(),
                block.source.as_str(),
                block.html.as_str(),
            )
        })
        .collect();
    assert_eq!(
        found,
        [
            ("k:title01", "# Plan", "<h1>Plan</h1>\n"),
            (
                "k:para_02",
                "First line\nlast line",
                "<p>First line\nlast line</p>\n"
            ),
            (
                "k:list-03",
                "- one\n- two",
                "<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n"
            ),
        ]
    );
    for block in &blocks {
        assert!(!block.source.contains("<!--") && !block.html.contains("k:"));
    }
}

#[test]
fn mixed_documents_keep_index_ids_for_unstamped_blocks() {
    assert_eq!(
        ids("# T <!-- k:title01 -->\n\nA\n\nB <!-- k:bbbb -->\n\nC\n"),
        ["k:title01", "b1", "k:bbbb", "b3"]
    );
    assert_eq!(
        ids("A <!-- k:same -->\n\nB <!-- k:same -->\n"),
        ["k:same", "b1"],
        "a repeated id stays with the first block"
    );
}

#[test]
fn only_a_valid_comment_ending_the_last_line_names_the_block() {
    let (source, id) = split_block_id("A <!-- k:first --> <!-- k:second -->");
    assert_eq!((source.as_str(), id.as_deref()), ("A", Some("k:first")));
    let (source, id) = split_block_id("Top <!-- k:early -->\nBottom");
    assert_eq!((source.as_str(), id), ("Top\nBottom", None));
    let (source, id) = split_block_id("A <!-- k:abc -->");
    assert_eq!(
        (source.as_str(), id),
        ("A <!-- k:abc -->", None),
        "too short"
    );
    let (_, id) = split_block_id("A <!-- k:has space -->");
    assert_eq!(id, None);
    let (_, id) = split_block_id("A <!-- k:abcd --> tail");
    assert_eq!(id, None, "text after the comment");
    let blocks = markdown_blocks("Top <!-- k:early -->\nBottom\n");
    assert_eq!(blocks[0].id, "b0");
    assert_eq!(blocks[0].html, "<p>Top\nBottom</p>\n");
    let code = markdown_blocks("Use `x <!-- k:abcd -->` here\n");
    assert_eq!(code[0].html, "<p>Use <code>x</code> here</p>\n");
}

#[test]
fn block_id_validation_accepts_both_forms() {
    for valid in [
        "b0",
        "b12345",
        "k:abcd",
        "k:A-b_9",
        &format!("k:{}", "z".repeat(32)),
    ] {
        assert!(is_valid_block_id(valid), "{valid}");
    }
    for invalid in [
        "k:abc",
        "k:",
        "k:a b c d",
        "k:<abcd>",
        &format!("k:{}", "z".repeat(33)),
        "x:abcd",
    ] {
        assert!(!is_valid_block_id(invalid), "{invalid}");
    }
    assert!(is_stable_block_id("k:7f3a9c2d"));
    assert!(!is_stable_block_id("b1"));
}

fn block(id: &str, source: &str) -> DocumentBlock {
    DocumentBlock {
        id: id.to_string(),
        source: source.to_string(),
        html: String::new(),
    }
}

fn targets(
    old: &[DocumentBlock],
    new: &[DocumentBlock],
    stamped: &[(&str, &str)],
) -> Vec<(String, String)> {
    let stamped: HashMap<String, String> = stamped
        .iter()
        .map(|(from, to)| (from.to_string(), to.to_string()))
        .collect();
    let mut found: Vec<_> = annotation_targets(old, new, &stamped).into_iter().collect();
    found.sort();
    found
}

fn pair(from: &str, to: &str) -> (String, String) {
    (from.to_string(), to.to_string())
}

#[test]
fn annotations_follow_stamps_stable_ids_and_sources() {
    let old = [
        block("b0", "# T"),
        block("b1", "A"),
        block("b2", "B"),
        block("b3", "C"),
    ];
    // First stamping save: explicit stamps win; other blocks follow by source.
    let new = [
        block("k:tttt", "# T"),
        block("k:aaaa", "A"),
        block("k:bbbb", "B"),
        block("k:cccc", "C"),
    ];
    assert_eq!(
        targets(&old, &new, &[("b3", "k:cccc")]),
        [
            pair("b0", "k:tttt"),
            pair("b1", "k:aaaa"),
            pair("b2", "k:bbbb"),
            pair("b3", "k:cccc")
        ]
    );
    // A stable block that moves and changes text keeps its annotations.
    let moved = [
        block("k:cccc", "C, edited"),
        block("k:tttt", "# T"),
        block("k:aaaa", "A"),
    ];
    assert_eq!(
        targets(&new, &moved, &[]),
        [pair("k:bbbb", "k:aaaa")],
        "the deleted block's annotations go to the block before it"
    );
    let first_gone = [block("k:aaaa", "A")];
    assert_eq!(
        targets(&new, &first_gone, &[]),
        [
            pair("k:bbbb", "k:aaaa"),
            pair("k:cccc", "k:aaaa"),
            pair("k:tttt", "k:aaaa")
        ]
    );
    assert_eq!(
        targets(&new, &[], &[]).len(),
        4,
        "an empty document falls back to b0"
    );
    assert!(targets(&new, &[], &[]).iter().all(|(_, to)| to == "b0"));
}

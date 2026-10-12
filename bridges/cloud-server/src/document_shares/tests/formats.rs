//! Pure tests for block remapping and inline formats.

use super::super::canonical::resolve_chain;
use super::super::inline_formats::split_highlights;
use super::super::render::{markdown_blocks, remap_block_ids, resolve_remap};

fn blocks(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

#[test]
fn unchanged_and_edited_blocks_keep_or_lose_their_place() {
    let old = blocks(&["# T", "A", "B"]);
    assert_eq!(remap_block_ids(&old, &old), [Some(0), Some(1), Some(2)]);
    // Edited text no longer matches; trimming ignores surrounding whitespace.
    assert_eq!(
        remap_block_ids(&old, &blocks(&["# T ", "A changed", "B"])),
        [Some(0), None, Some(2)]
    );
}

#[test]
fn inserted_deleted_and_moved_blocks_follow_their_source() {
    let old = blocks(&["# T", "A", "B", "C"]);
    assert_eq!(
        remap_block_ids(&old, &blocks(&["# T", "New", "A", "B", "C"])),
        [Some(0), Some(2), Some(3), Some(4)]
    );
    assert_eq!(
        remap_block_ids(&old, &blocks(&["# T", "B", "C"])),
        [Some(0), None, Some(1), Some(2)]
    );
    assert_eq!(
        remap_block_ids(&old, &blocks(&["C", "# T", "A", "B"])),
        [Some(1), Some(2), Some(3), Some(0)]
    );
}

#[test]
fn repeated_blocks_take_the_first_unmatched_occurrence() {
    let old = blocks(&["---", "A", "---"]);
    assert_eq!(
        remap_block_ids(&old, &blocks(&["---", "---", "A"])),
        [Some(0), Some(2), Some(1)]
    );
    assert_eq!(
        remap_block_ids(&old, &blocks(&["A", "---"])),
        [Some(1), Some(0), None]
    );
}

#[test]
fn vanished_blocks_go_to_the_nearest_surviving_block_before_them() {
    assert_eq!(resolve_remap(&[Some(0), None, Some(1)]), [0, 0, 1]);
    assert_eq!(resolve_remap(&[None, None, Some(3)]), [0, 0, 3]);
    assert_eq!(resolve_remap(&[Some(2), None, None]), [2, 2, 2]);
    assert!(resolve_remap(&[]).is_empty());
}

#[test]
fn underline_and_mark_are_the_only_inline_html() {
    let html = &markdown_blocks(
        "Some <u>under</u> and <mark>marked</mark> <span>x</span> <U>y</U> <u class=\"a\">z</u>.\n",
    )[0]
    .html;
    assert_eq!(
        html,
        "<p>Some <u>under</u> and <mark>marked</mark> x y z.</p>\n"
    );
    let unbalanced = &markdown_blocks("Open <u>never closed\n\nStray </mark> close\n")[..];
    assert_eq!(unbalanced[0].html, "<p>Open <u>never closed</u></p>\n");
    assert_eq!(unbalanced[1].html, "<p>Stray  close</p>\n");
}

#[test]
fn double_equals_render_as_mark_outside_code() {
    assert_eq!(
        markdown_blocks("A ==key point== here.\n")[0].html,
        "<p>A <mark>key point</mark> here.</p>\n"
    );
    assert_eq!(
        markdown_blocks("## ==Title==\n")[0].html,
        "<h2><mark>Title</mark></h2>\n"
    );
    assert_eq!(
        markdown_blocks("- ==one==\n- two\n")[0].html,
        "<ul>\n<li><mark>one</mark></li>\n<li>two</li>\n</ul>\n"
    );
    assert_eq!(
        markdown_blocks("Use `a == b` and `==x==`.\n")[0].html,
        "<p>Use <code>a == b</code> and <code>==x==</code>.</p>\n"
    );
    assert_eq!(
        markdown_blocks("```\n==x==\n```\n")[0].html,
        "<pre><code>==x==\n</code></pre>\n"
    );
    assert_eq!(
        markdown_blocks("x == y and a <b>==z==</b>\n")[0].html,
        "<p>x == y and a <mark>z</mark></p>\n"
    );
}

#[test]
fn highlight_splitting_leaves_unmatched_markers_literal() {
    assert_eq!(
        split_highlights("no marks"),
        [(false, "no marks".to_string())]
    );
    assert_eq!(
        split_highlights("a ==b== c ==d"),
        [
            (false, "a ".to_string()),
            (true, "b".to_string()),
            (false, " c ==d".to_string())
        ]
    );
    assert_eq!(split_highlights("====x"), [(false, "====x".to_string())]);
}

fn link(id: &str, source: Option<&str>) -> (String, Option<String>) {
    (id.to_string(), source.map(str::to_string))
}

#[test]
fn copies_resolve_to_the_end_of_their_source_chain() {
    assert_eq!(
        resolve_chain("att_root", &[link("att_root", None)]),
        "att_root"
    );
    assert_eq!(resolve_chain("att_unknown", &[]), "att_unknown");
    let chain = [
        link("att_copy2", Some("att_copy")),
        link("att_copy", Some("att_root")),
        link("att_root", None),
    ];
    assert_eq!(resolve_chain("att_copy2", &chain), "att_root");
    assert_eq!(resolve_chain("att_copy", &chain), "att_root");
    // A source that no longer exists ends the chain at the last known copy.
    assert_eq!(
        resolve_chain("att_copy", &[link("att_copy", Some("att_gone"))]),
        "att_copy"
    );
    let cycle = [link("att_a", Some("att_b")), link("att_b", Some("att_a"))];
    assert_eq!(resolve_chain("att_a", &cycle), "att_b");
    let long: Vec<_> = (0..=20)
        .map(|index| (format!("att_{index}"), Some(format!("att_{}", index + 1))))
        .collect();
    assert_eq!(resolve_chain("att_0", &long), "att_8", "at most eight hops");
}

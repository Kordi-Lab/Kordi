use super::super::render_transcript;
use crate::tui::TuiAppConfig;
use crate::tui::layout::Size;
use crate::tui::runtime::TuiState;

#[test]
fn edit_diff_rows_only_highlight_changed_lines_and_fill_width() {
    let t = crate::theme::theme();
    let diff = format!(
        "applied 1/1 edit(s) to foo.txt\n    {}  1 before{}\n{}    {}- 2 old{}\n{}    {}+ 2 new{}\n    {}  3 after{}",
        t.diff_context,
        t.reset,
        t.diff_removed_bg,
        t.diff_removed,
        t.reset,
        t.diff_added_bg,
        t.diff_added,
        t.reset,
        t.diff_context,
        t.reset,
    );

    let mut transcript = crate::tui::transcript::Transcript::new();
    let assistant = transcript.append_root_block(
        crate::tui::transcript::NewBlock::new(
            crate::tui::transcript::BlockKind::AssistantMessage,
            "assistant",
        )
        .with_content(""),
    );
    let tool = transcript
        .append_child_block(
            assistant,
            crate::tui::transcript::NewBlock::new(
                crate::tui::transcript::BlockKind::ToolUse,
                "Edit(foo.txt) • done",
            )
            .with_expandable(true),
        )
        .expect("tool block");
    let _ = transcript
        .append_child_block(
            tool,
            crate::tui::transcript::NewBlock::new(
                crate::tui::transcript::BlockKind::ToolResult,
                "output",
            )
            .with_content(diff),
        )
        .expect("tool result");

    let width = 60usize;
    let state = TuiState::new(
        TuiAppConfig {
            transcript,
            ..TuiAppConfig::default()
        },
        Size {
            width: width as u16,
            height: 24,
        },
    );
    let lines = render_transcript(&state, &state.projection, width, 24);

    let context = lines
        .iter()
        .find(|line| crate::utils::strip_ansi(line).contains("1 before"))
        .expect("context line");
    let removed = lines
        .iter()
        .find(|line| crate::utils::strip_ansi(line).contains("old"))
        .expect("removed line");
    let added = lines
        .iter()
        .find(|line| crate::utils::strip_ansi(line).contains("new"))
        .expect("added line");

    if t.colors_enabled() {
        assert!(!context.contains(&t.diff_removed_bg));
        assert!(!context.contains(&t.diff_added_bg));
        assert!(removed.contains(&t.diff_removed_bg));
        assert!(added.contains(&t.diff_added_bg));
    } else {
        for line in [context, removed, added] {
            assert!(!line.contains("\x1b["));
        }
    }

    assert_eq!(crate::utils::visible_width(removed), width);
    assert_eq!(crate::utils::visible_width(added), width);
}

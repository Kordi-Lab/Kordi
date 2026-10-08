pub(super) fn compact_tool_description(description: &str) -> String {
    let normalized = description.split_whitespace().collect::<Vec<_>>().join(" ");
    let first_sentence = normalized
        .split_once(". ")
        .map(|(sentence, _)| sentence)
        .unwrap_or(normalized.as_str())
        .trim();
    truncate_chars(first_sentence, 160)
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }

    let mut truncated = value
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect::<String>();
    truncated.push('…');
    truncated
}

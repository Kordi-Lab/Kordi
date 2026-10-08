pub(super) fn is_auto_compaction_status(message: &str) -> bool {
    message.starts_with("Auto-compacted session:")
}

pub(super) fn is_auto_compaction_terminal_status(message: &str) -> bool {
    is_auto_compaction_status(message) || message.starts_with("Auto-compaction failed:")
}

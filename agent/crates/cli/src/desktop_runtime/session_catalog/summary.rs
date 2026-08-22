use anyhow::Result;

use super::super::DesktopChatSessionSummary;
use super::{
    fallback_session_display_title, repair_session_title_from_history, session_activity_label,
    session_activity_timestamp_ms,
};

pub(super) fn session_summary_from_row(
    conn: &rusqlite::Connection,
    row: kordi_session::store::SessionRow,
) -> Result<DesktopChatSessionSummary> {
    let updated_at_ms = session_activity_timestamp_ms(conn, &row);
    let updated_at_label = session_activity_label(conn, &row);
    let title = repair_session_title_from_history(conn, &row)?
        .unwrap_or_else(|| fallback_session_display_title(&row));
    let subtitle = match kordi_session::context::build_context(conn, &row.session_id) {
        Ok(context) => context
            .model
            .map(|model| format!("{}/{}", model.provider, model.model_id))
            .unwrap_or_else(|| format!("{} entries", row.entry_count)),
        Err(_) => format!("{} entries", row.entry_count),
    };
    let background_status = row.parent_session_id.as_ref().and_then(|_| {
        crate::task_operator::inspect_persisted_background_session(conn, &row.session_id)
            .ok()
            .map(|inspection| inspection.status)
    });

    Ok(DesktopChatSessionSummary {
        id: row.session_id,
        title,
        subtitle,
        updated_at_label,
        updated_at_ms,
        message_count: row.entry_count.max(0) as usize,
        draft: false,
        background_status,
        forked_from_session_id: row.parent_session_id,
        forked_from_message_id: row.parent_session_message_id,
    })
}

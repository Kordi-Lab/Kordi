pub(super) type AccountRecordRow = (
    String,
    i64,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);
pub(super) type ContactListRow = (String, i64, Option<String>, Option<String>, String);
pub(super) type ContactRequestRow = (
    String,
    String,
    String,
    String,
    Option<String>,
    String,
    Option<String>,
);
pub(super) type CloudSyncEventRow = (
    i64,
    String,
    Option<String>,
    Option<String>,
    serde_json::Value,
    String,
);
pub(super) type AttachmentOwnerRow = (String, String, Option<String>, Option<i64>, Option<String>);
pub(super) type MessageRecordRow = (
    String,
    String,
    String,
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
);
pub(super) type MessageAttachmentRow = (
    String,
    String,
    String,
    String,
    Option<String>,
    Option<i64>,
    Option<String>,
    String,
);

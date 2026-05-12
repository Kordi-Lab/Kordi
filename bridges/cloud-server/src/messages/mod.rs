//! `server_messages` + `server_message_recipients` write layer. Foundation
//! for the Telegram-style message-log path that replaces the legacy
//! per-recipient mailbox-row fanout.

pub mod log;

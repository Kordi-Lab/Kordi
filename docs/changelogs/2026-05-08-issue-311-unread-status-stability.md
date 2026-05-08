# Issue 311: Unread and sent-status UI stability

- Kept Bridge unread counts stable when a stale mailbox/realtime snapshot replays the same inbound request after the UI has already marked it read.
- Allowed unread counts to increase when a later snapshot contains a genuinely new inbound request.
- Switched chat transcript row keys to stable message render keys so sent-message status metadata changes do not remount the whole message row or refresh anchored UI.
- Moved outgoing compact delivery status into a fixed bottom-right slot, matching Telegram-style stable bottom info: the bubble geometry stays stable while only the icon/tone changes.
- Added regression coverage for stale unread replay, volatile sent-status render keys, and fixed delivery-status geometry.

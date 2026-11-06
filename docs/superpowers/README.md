# Historical design records

Historical design specifications are kept outside the publishable source tree.
They described designs at the time they were proposed and are not the current
product architecture or an executable backlog. Historical implementation
plans have been removed from the publishable source tree.

In particular, references to `cloud_messages`, `cloud_sync_events`, mailbox
tables, or `/v1/cloud/messages` describe superseded chat implementations. The
current and only product message-sync architecture is documented in
[`../cloud-mobile.md`](../cloud-mobile.md) and
[`../../shared/chat-sync/README.md`](../../shared/chat-sync/README.md).

Do not restore a historical route or storage model from these records.

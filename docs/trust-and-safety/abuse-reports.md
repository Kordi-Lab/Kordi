# Abuse reports

People can tell Kordi about an account, a contact request, or specific
messages. This page describes what a report contains, how long it is kept,
and how named operators review it. User-visible behaviour is summarized in
[contacts, blocking, and leaving groups](contacts-and-blocking.md#reports).

## What a report contains

`POST /v1/cloud/reports` (signed in) accepts:

```json
{
  "clientReportId": "uuid chosen by the app, one per report",
  "reason": "spam | harassment | scam | impersonation | inappropriate | other",
  "details": "optional, at most 1,000 characters",
  "reportedAccountId": "acct_… (required when no messages are chosen)",
  "conversationId": "uuid (required when messages are chosen)",
  "messageIds": ["up to 50 message ids"],
  "contactRequestId": "req_… (optional)"
}
```

The server builds the evidence itself; it never stores content the app sends
apart from the reason and the optional details:

- for each chosen message: its id, sender account, kind, timestamps, version,
  the stored content as it is at report time, and attachment metadata (id,
  content type, size, SHA-256). Attachment bytes are never copied;
- the conversation's id, kind, session id, and active member count;
- a contact request, only when it was sent to the reporter by the reported
  account.

Checks, in order:

1. The request shape (reason, details length, at most 50 distinct
   messages); failures return 400 `invalid_report`.
2. A report with the same `clientReportId` returns the stored receipt (200)
   when the request is identical, or 409 `report_conflict` when it differs.
   Replays never use the daily budget.
3. Each account can send 20 reports per 24 hours (429 `rate_limited`).
4. The reporter must still be an active member of the conversation, and
   every chosen message must belong to it and not be deleted. When no
   account is named, the reported account is the sender of the first chosen
   message not written by the reporter; at least one chosen message must be
   from the reported account (an agent's messages count for its owner).
   Failures return 400 `invalid_report_evidence`.
5. The reported account must exist (404 `account_missing`) and must not be
   the reporter (400 `self_report`).
6. Evidence larger than 2 MiB returns 413 `report_too_large`.

A new report returns 201 with a receipt:
`{ reportId, reference, status: "received", reason, targetKind,
evidenceMessageCount, reportedDisplayName, createdAt, closedAt }`. The
reference (`R-` and eight characters) is what people quote. `GET
/v1/cloud/reports` lists the caller's own receipts, newest first (at most
100), with `status` `received` or `closed`, and never evidence or the
resolution.

Blocking someone never creates a report. The audit event
`safety.report.created` records only the report id, reason, and target kind,
and server logs never contain report content.

## Retention

- Open reports that nobody reviewed are closed automatically after 180 days
  with the resolution `expired_unreviewed`.
- Closed reports are deleted 90 days after they were closed, together with
  their access log.
- The server's report retention worker applies both rules every six hours.
  There is no way to extend retention from the product.
- The worker only touches reports. It does not delete the archive of the
  contact conversion from migration 110: that archive is the only way to
  revert the conversion, so it is kept until an operator runs the explicit
  purge described in the migration notes.
- A report's copy of a message does not change when its sender deletes it for
  everyone or edits it, or when someone removes it from their own view. The
  text and attachment metadata, SHA-256 included, stay in the report until the
  rules above delete it; content removal never reads reports. See
  [data deletion](../data-deletion.md#what-is-kept-and-for-how-long).

## Operator access

Only named operators review reports, through the approved operator database
access path. Never copy report content into tickets, chat, or exports; refer
to a report by its `report_id` or reference.

- Queue (metadata only):

  ```sql
  SELECT * FROM kordi_safety_report_queue;
  ```

- Read one report. Every read is logged with the operator's name:

  ```sql
  SELECT * FROM kordi_safety_view_report('<report_id>', '<operator name>');
  ```

- Close a report with one of `no_action`, `warned`, `restricted`,
  `content_removed`, or `duplicate`. The close is logged, and closing an
  already closed report returns `false`:

  ```sql
  SELECT kordi_safety_close_report('<report_id>', '<operator name>', '<resolution>');
  ```

Both functions refuse an empty operator name. The access log is
`cloud_abuse_report_access_log`.

## Limitations

- The application's database role can read the report table directly. Role
  separation for report access is future operations work.
- Apps do not list sent reports yet; the list endpoint exists for them.
- Kordi does not notify the reporter or the reported account about decisions.

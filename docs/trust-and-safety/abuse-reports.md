# Abuse reports

People can tell Kordi about an account, a contact request, or specific
messages. Reports reach a person through the support inbox, and named
operators review them through logged database functions. The reported person
is never told.

## Sending a report

`POST /v1/cloud/reports` (signed in) accepts:

```json
{
  "clientReportId": "uuid chosen by the app, one per report",
  "reason": "spam | harassment | scam | impersonation | inappropriate | other",
  "details": "optional, at most 1,000 characters",
  "reportedAccountId": "required when no messages are chosen",
  "conversationId": "uuid, required when messages are chosen",
  "messageIds": ["up to 50 message ids"],
  "contactRequestId": "optional",
  "alsoBlock": false
}
```

The apps show four reasons: Spam (`spam`), Harassment or hate (`harassment`),
Sexual or violent content (`inappropriate`), and Something else (`other`).
The server also accepts `scam` and `impersonation`.

The server builds the evidence itself; apart from the reason and the optional
details it never stores content the app sends:

- for each chosen message: its id, sender account, kind, timestamps, version,
  the stored content as it is at report time, and attachment metadata (id,
  content type, size, SHA-256). Attachment bytes are never copied;
- the conversation's id, kind, session id, and active member count;
- a contact request, only when the reported account sent it to the reporter.

Checks, in order:

1. The request shape (reason, details length, at most 50 distinct messages);
   failures return 400 `invalid_report`.
2. A report with the same `clientReportId` returns the stored receipt (200)
   when the request is identical, or 409 `report_conflict` when it differs.
3. The reporter must be, or have been, a member of the conversation, and
   every chosen message must belong to it; someone who left can report
   messages sent before they left. A message its sender deleted for everyone
   stays reportable: the copy keeps its id, sender, times (including
   `deletedAt`), and whatever content remains. When no account is
   named, the reported account is the sender of the first chosen message not
   written by the reporter; at least one chosen message must be from the
   reported account (an agent's messages are sent as its owner). Failures
   return 400 `invalid_report_evidence`.
4. The reported account must exist (404 `account_missing`) and must not be the
   reporter (400 `self_report`).
5. Evidence larger than 2 MiB returns 413 `report_too_large`.
6. Each account can send 20 reports per 24 hours (429 `rate_limited`). Only
   reports that passed every check above count; replays never count.

A new report returns 201 with
`{ "report": { reportId, reference, status, reason, targetKind,
evidenceMessageCount, reportedDisplayName, createdAt, closedAt },
"blocked": bool }`. The reference (`R-` and eight characters) is what people
quote. With `alsoBlock`, the server blocks the reported account in the same
request (see [blocking](blocking.md)) and `blocked` says whether it did.
`GET /v1/cloud/reports` lists the caller's own receipts, newest first (at most
100), without evidence or resolution.

The audit event `safety.report.created` records only the report id, reason,
and target kind. Server logs never contain report content.

## How a report reaches a person

Each new report queues a notice to the support inbox (`KORDI_SUPPORT_INBOX`,
sent with the `KORDI_SUPPORT_SMTP_*` settings the support tickets use). The
notice carries only the reference, report id, reason, target kind, message
count, the reported account id, and the operator query to open the report. It
never contains the reporter, the details, or the copied messages. The server tries to send it
right away; a worker retries every 30 seconds with backoff (1, 5, 15, 60, then
360 minutes) and marks the notice `failed` after eight attempts. Without a
configured mailer, reports wait in the queue view below with
`notification_status = 'pending'`. Operators should review new reports within
24 hours.

## Operator access

The server has no operator role or admin route, so review happens in the
database. The operations runbook covers access; the procedure is:

1. Each day, list open reports with the queue view and start with the oldest.
2. Read each report with `kordi_safety_view_report`, giving your name.
3. Act in the product when needed: remove content, or restrict the account
   through the operations runbook.
4. Close the report with `kordi_safety_close_report` and the matching
   resolution.

Only named operators review reports, through the approved operator database
access path. Never copy report content into tickets, chat, or exports; refer to
a report by its `report_id` or reference.

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

## Retention

- Open reports nobody reviewed close after 180 days with the resolution
  `expired_unreviewed`.
- Closed reports are deleted 90 days after they were closed, together with
  their access log.
- The server's report retention worker applies both rules every six hours.
- A report's copy of a message does not change when its sender edits or
  deletes it; content removal never reads reports.

## Account deletion

Reports reference the reporter and the reported account with
`ON DELETE SET NULL`. Deleting either account keeps the report, its copied
evidence, and `reported_display_name` until the retention rules above remove
it, so a person cannot erase a report against them by deleting their account,
and a reporter's deletion does not cancel the review. Account deletion must not
delete `cloud_abuse_reports` rows directly.

## Limitations

- The application's database role can read the report table directly. Role
  separation for report access is future operations work.
- Apps do not list sent reports yet; the list endpoint exists for them.
- Kordi does not notify the reporter or the reported account about decisions.

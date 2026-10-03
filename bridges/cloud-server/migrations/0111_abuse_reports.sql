-- Abuse reports.
--
-- A report records what a person told Kordi about another account and, when
-- they chose messages, a server-built copy of exactly those messages with
-- attachment metadata (never attachment bytes). Reports are read only by
-- named operators through the logged functions below. Open reports close
-- automatically after 180 days and closed reports are deleted 90 days after
-- closing (the server's report retention worker does both).

CREATE TABLE IF NOT EXISTS cloud_abuse_reports (
    report_id              TEXT PRIMARY KEY,
    reporter_account_id    TEXT REFERENCES cloud_accounts(account_id) ON DELETE SET NULL,
    client_report_id       UUID NOT NULL,
    request_fingerprint    TEXT NOT NULL,
    reported_account_id    TEXT REFERENCES cloud_accounts(account_id) ON DELETE SET NULL,
    reported_display_name  TEXT,
    target_kind            TEXT NOT NULL CHECK (target_kind IN ('account', 'message')),
    reason                 TEXT NOT NULL CHECK (reason IN (
                               'spam', 'harassment', 'scam', 'impersonation', 'inappropriate',
                               'other')),
    details                TEXT CHECK (details IS NULL OR char_length(details) <= 1000),
    conversation_id        UUID,
    evidence               JSONB NOT NULL,
    evidence_message_count INTEGER NOT NULL DEFAULT 0
                               CHECK (evidence_message_count BETWEEN 0 AND 50),
    status                 TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    resolution             TEXT CHECK (resolution IS NULL OR resolution IN (
                               'no_action', 'warned', 'restricted', 'content_removed',
                               'duplicate', 'expired_unreviewed')),
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at              TIMESTAMPTZ,
    CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_abuse_reports_idempotency
    ON cloud_abuse_reports (reporter_account_id, client_report_id);
CREATE INDEX IF NOT EXISTS idx_cloud_abuse_reports_open
    ON cloud_abuse_reports (status, created_at);
CREATE INDEX IF NOT EXISTS idx_cloud_abuse_reports_closed
    ON cloud_abuse_reports (closed_at) WHERE closed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cloud_abuse_reports_reported
    ON cloud_abuse_reports (reported_account_id, created_at);

-- Every operator read and decision, kept as long as the report.
CREATE TABLE IF NOT EXISTS cloud_abuse_report_access_log (
    access_id      BIGSERIAL PRIMARY KEY,
    report_id      TEXT NOT NULL REFERENCES cloud_abuse_reports(report_id) ON DELETE CASCADE,
    operator_label TEXT NOT NULL CHECK (char_length(operator_label) BETWEEN 1 AND 120),
    action         TEXT NOT NULL CHECK (action IN ('view', 'close')),
    accessed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cloud_abuse_report_access_log_report
    ON cloud_abuse_report_access_log (report_id, accessed_at);

-- The open queue shows metadata only; reading a report goes through the
-- logged function.
CREATE OR REPLACE VIEW kordi_safety_report_queue AS
    SELECT report_id, created_at, reason, target_kind, reported_account_id,
           evidence_message_count, status
    FROM cloud_abuse_reports
    WHERE status = 'open'
    ORDER BY created_at;

CREATE OR REPLACE FUNCTION kordi_safety_view_report(p_report_id TEXT, p_operator TEXT)
RETURNS SETOF cloud_abuse_reports LANGUAGE plpgsql AS $$
BEGIN
    IF p_operator IS NULL OR btrim(p_operator) = '' THEN
        RAISE EXCEPTION 'an operator name is required to read a report';
    END IF;
    INSERT INTO cloud_abuse_report_access_log (report_id, operator_label, action)
    SELECT report.report_id, btrim(p_operator), 'view'
    FROM cloud_abuse_reports report
    WHERE report.report_id = p_report_id;
    RETURN QUERY SELECT * FROM cloud_abuse_reports report WHERE report.report_id = p_report_id;
END $$;

CREATE OR REPLACE FUNCTION kordi_safety_close_report(
    p_report_id TEXT, p_operator TEXT, p_resolution TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
    closed_count INTEGER;
BEGIN
    IF p_operator IS NULL OR btrim(p_operator) = '' THEN
        RAISE EXCEPTION 'an operator name is required to close a report';
    END IF;
    IF p_resolution IS NULL OR p_resolution NOT IN (
        'no_action', 'warned', 'restricted', 'content_removed', 'duplicate') THEN
        RAISE EXCEPTION 'unknown report resolution: %', p_resolution;
    END IF;
    UPDATE cloud_abuse_reports
    SET status = 'closed', resolution = p_resolution, closed_at = now()
    WHERE report_id = p_report_id AND status = 'open';
    GET DIAGNOSTICS closed_count = ROW_COUNT;
    IF closed_count = 0 THEN
        RETURN FALSE;
    END IF;
    INSERT INTO cloud_abuse_report_access_log (report_id, operator_label, action)
    VALUES (p_report_id, btrim(p_operator), 'close');
    RETURN TRUE;
END $$;

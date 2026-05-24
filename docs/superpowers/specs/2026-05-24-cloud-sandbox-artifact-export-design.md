# Cloud Sandbox Artifact Export Design

## Parent issue

- Parent: #479 Keep agents reachable while owner device is offline
- Runtime umbrella: #494 Cloud sandbox fallback runtime
- Slice purpose: add explicit full-byte artifact export from Cloud sandbox runs to Cloud chat while keeping unexported sandbox files private.

## Goal

Let a Cloud Agent Runner explicitly share a sandbox file as a Cloud chat artifact/attachment. Export must include object bytes, not only metadata. The server remains the persistence and authorization boundary: runner sends bytes to Cloud server, Cloud server writes object storage rows/objects, and existing Cloud attachment access rules decide who can download the result.

## Non-goals

- No automatic export of all sandbox files.
- No direct runner access to object-storage credentials or buckets.
- No owner-laptop filesystem access.
- No private sandbox file browsing by chat participants.
- No broad artifact UI redesign.
- No real model/tool loop work beyond exposing an explicit export path the runner can call.

## Export model

Artifact export is explicit. A file created in the sandbox remains private until the runner calls a runner-auth endpoint for a specific run and sends the file bytes.

Runner endpoint:

`POST /v1/cloud/agent-runs/:run_id/artifacts`

Request shape:

```json
{
  "runnerId": "runner-a",
  "name": "report.md",
  "sandboxPath": "report.md",
  "contentType": "text/markdown",
  "sha256Hex": "<64 lowercase hex chars>",
  "bytesBase64": "IyBSZXBvcnQK"
}
```

Use JSON with base64 bytes for this slice. It keeps tests simple and avoids introducing multipart parsing. Enforce a conservative request size limit for runner exports in code; larger artifact streaming can be a later hardening slice.

Response shape:

```json
{
  "artifact": {
    "artifactId": "carartifact_...",
    "attachmentId": "att_...",
    "runId": "car_...",
    "messageId": "cloudrunmsg_...",
    "name": "report.md",
    "sandboxPath": "report.md",
    "contentType": "text/markdown",
    "sizeBytes": 9,
    "sha256Hex": "...",
    "createdAt": "..."
  }
}
```

## Server responsibilities

The Cloud server endpoint must:

1. Authenticate with `KORDI_CLOUD_RUNNER_TOKEN`.
2. Require non-empty `runnerId`, `name`, `sandboxPath`, `contentType`, and `bytesBase64`.
3. Reject absolute paths, `..` traversal, home paths, owner-local paths, and unsupported path forms in `sandboxPath`.
4. Verify the run exists, is claimed by `runnerId`, has a `sandbox_id`, and is in `leased`, `running`, or `completed` status.
5. Verify bytes decode successfully and match `sha256Hex` when provided.
6. Create/fetch the run response Cloud message so the export has a participant-visible message to attach to.
7. Create a `cloud_attachments` row with an object key under `attachments/<owner_account_id>/<attachment_id>`.
8. Upload bytes to object storage through server-owned S3/MinIO configuration.
9. Finalize attachment metadata with size, content type, and sha256.
10. Insert a `cloud_message_attachments` row linking the attachment to the run response message.
11. Insert a `cloud_session_artifacts` row for activity/sidebar visibility, linked to the same attachment and source message.
12. Insert a runtime-specific audit/link row so exports can be queried by run and so unexported sandbox files remain unrepresented in Cloud metadata.

## Response message behavior

The existing runner complete endpoint already returns a `responseMessageId`, but today it only records that ID on the fallback run. This slice should make that ID real by inserting a `cloud_messages` row for the run response when needed.

Rules:

- The response message ID is stable per run.
- If the runner exports before completion, the server creates a placeholder response message body such as `Shared sandbox artifact.` and stores/uses that message ID.
- When `complete` later runs with a non-empty response text, it updates that same message body instead of creating a second response message.
- If completion happens before export, export reuses the existing response message.
- The message is from `owner_account_id` to `requester_account_id` and carries the run `session_id`.

This keeps artifact visibility tied to the existing `cloud_message_attachments` authorization path.

## Data model

Add a migration after `0020_cloud_agent_sandboxes.sql`:

`0021_cloud_agent_run_artifacts.sql`

Create `cloud_agent_run_artifacts`:

- `artifact_id TEXT PRIMARY KEY`
- `run_id TEXT NOT NULL REFERENCES cloud_agent_fallback_runs(run_id) ON DELETE CASCADE`
- `sandbox_id TEXT NOT NULL REFERENCES cloud_agent_sandboxes(sandbox_id) ON DELETE RESTRICT`
- `attachment_id TEXT NOT NULL REFERENCES cloud_attachments(attachment_id) ON DELETE RESTRICT`
- `message_id TEXT NOT NULL REFERENCES cloud_messages(message_id) ON DELETE CASCADE`
- `sandbox_path TEXT NOT NULL`
- `name TEXT NOT NULL`
- `content_type TEXT NOT NULL`
- `size_bytes BIGINT NOT NULL`
- `sha256_hex TEXT`
- `created_at TEXT NOT NULL`

Indexes:

- `(run_id, created_at)`
- `(attachment_id)`
- unique `(run_id, sandbox_path, sha256_hex)` to make retrying the same explicit export idempotent when a hash is provided.

No table is created for private sandbox files. If there is no row, Cloud has no participant-visible artifact.

## Runner responsibilities

Add `bridges/cloud-agent-runner/src/artifacts.rs` with a small client/helper that:

1. Accepts a leased run, sandbox root/client, and relative file path.
2. Resolves the path through the existing sandbox path boundary.
3. Reads bytes from the sandbox backend.
4. Computes sha256 and content length.
5. Calls `POST /v1/cloud/agent-runs/:run_id/artifacts` with runner auth.
6. Returns the exported artifact summary.

The helper must not run automatically for every file. Runtime/model integration must call it only for an explicit share/export action.

## Privacy and authorization

- Unexported sandbox files are not represented in `cloud_attachments`, `cloud_message_attachments`, or `cloud_session_artifacts`.
- Download/content access remains delegated to the existing attachment routes.
- The attachment owner can fetch it.
- Recipients can fetch it only after it is linked to a Cloud message addressed to them.
- Unrelated accounts receive `404` for download/content requests.
- Expiring or deleting sandbox metadata does not remove exported attachment rows or object bytes.

## Errors

Use explicit JSON error codes:

- `invalid_runner_token` for missing/bad runner auth.
- `invalid_artifact_export` for missing fields, invalid path, invalid base64, size mismatch, or sha mismatch.
- `artifact_too_large` for request bytes above the configured slice limit.
- `agent_run_not_found` when the run is missing, not owned by the runner, lacks a sandbox, or is in a non-exportable status.
- `attachments_unavailable` when object storage is not configured.
- `server_error` for unexpected storage/database failures.

Failures must not create partially visible artifacts. If object upload succeeds but database linking fails, the endpoint should return an error and avoid inserting `cloud_message_attachments`; cleanup can be a later GC concern.

## Testing

Backend e2e with real Postgres/Object-storage-capable test state where possible:

- Runner export requires runner token; user token and bad runner token are rejected.
- Export rejects owner-local/absolute/traversal sandbox paths.
- Export rejects sha mismatch.
- Unexported sandbox file creates no attachment/artifact rows.
- Explicit export creates `cloud_attachments`, `cloud_message_attachments`, `cloud_session_artifacts`, and `cloud_agent_run_artifacts` rows.
- Exported content can be fetched by the requester via `/v1/cloud/attachments/:id/content`.
- Unrelated account receives `404` for the same content endpoint.
- Export before completion uses a placeholder response message; completion updates that message body without losing attachment links.
- Export after completion links to the completed response message.
- Expired sandbox metadata does not delete exported attachment metadata.

Runner tests:

- Artifact helper reads a sandbox-local file, computes sha256, and posts bytes.
- Artifact helper blocks traversal/owner-local paths before making an HTTP request.
- Artifact helper does not auto-export files created by normal sandbox writes.

## Deployment notes

No runner deployment should be applied in this slice. Server-side artifact endpoint can deploy after tests pass, but the runner skeleton still should not be deployed as a live queue consumer until the real model loop has safe non-placeholder behavior.

## Self-review

- Placeholder scan: no TODO/TBD placeholders remain.
- Scope check: this slice is focused on explicit full-byte artifact export and the minimum response-message persistence needed for participant-visible attachments.
- Consistency check: object bytes flow through the Cloud server, not directly from runner to object storage, preserving the server as authorization boundary.
- Ambiguity check: export is explicit only; unexported sandbox files have no Cloud metadata and are not visible to chat participants.

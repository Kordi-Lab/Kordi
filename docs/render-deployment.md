# Render validation deployment

This is an isolated first deployment of the core backend, using synthetic accounts
and a new private attachment bucket. It is not a completed product migration.
The reusable Blueprint is `deploy/render/render.yaml`. It creates a single API,
private OMP provider service, private durable NATS service, managed Postgres, and
managed Key Value in Oregon. Automatic deploys are disabled.

## Prerequisites and deployment

1. Review the current [Render prices](https://render.com/pricing) and the Blueprint
   resource plans before applying. This is paid infrastructure, not a free-tier
   deployment. Workspace fees, database/disk storage, outbound traffic, email,
   object storage, and model usage are separate costs.
2. Use a dedicated validation workspace without product credentials or data. Render
   private networking is shared within a workspace and region; a project label by
   itself is not a network security boundary. No database, cache, event bus, or
   provider worker should have an external endpoint.
3. Create a private S3-compatible bucket and bucket-scoped credentials. Grant the
   bucket metadata/read/write and multipart operations used by the attachment API.
   Keep public access disabled. The API proxies authenticated transfers. Use an
   HTTPS S3 API endpoint, not a public bucket URL. For R2, use region `auto`.
4. Configure a verified, test-owned SMTP sender supporting STARTTLS on port 587.
   The Blueprint asks for SMTP and S3 settings using `sync: false`; enter them in
   Render, never in a repository, PR, shell argument, or chat. A working mailbox
   alone is not evidence of a transactional SMTP service. Sender DNS verification
   does not require changing the backend's product domain.
5. Connect the repository in Render and create a Blueprint from the reviewed
   branch, using `deploy/render/render.yaml` as its path. First run:

   ```sh
   render blueprints validate deploy/render/render.yaml
   ```

   Check the five-resource plan, region, prices, and supplied settings. Then sync
   the Blueprint. The service names are examples for an empty validation workspace;
   Render can adopt resources with matching names, so check for collisions first.
6. Configure separate developer Google and GitHub OAuth applications on the API:
   `KORDI_OAUTH_GOOGLE_CLIENT_ID`, `KORDI_OAUTH_GOOGLE_CLIENT_SECRET`,
   `KORDI_OAUTH_GITHUB_CLIENT_ID`, and `KORDI_OAUTH_GITHUB_CLIENT_SECRET`.
   Register the callbacks used by the server at the validation API origin.
   Keep both sign-in options visible; incomplete credentials must produce an
   actionable sign-in error, not a hidden entry point.
7. Deploy manually at a reviewed commit. The API bootstraps the `KORDI_EVENTS`
   stream if absent, preserves existing stream settings, then starts the server
   on Render's `PORT`. New streams retain up to seven days or 7 GiB of events.
   NATS has a 10 GB persistent disk and a generated token shared only with the API.
   The API reads `KORDI_NATS_TOKEN` explicitly; keep credentials out of `NATS_URL`.
   NATS restarts interrupt event delivery; this single-instance setup is not HA.

`/health` is liveness only. `/ready` has a three-second deadline and checks
Postgres, the NATS stream, Redis, signed S3 bucket access, and the presence of parsed
signup email configuration. It never returns connection details. It does **not**
prove SMTP delivery, S3 writes, OAuth callback behavior, or background job success;
those require the acceptance checks below. A bucket policy denying `HeadBucket`
will correctly keep this deployment unready until the policy is corrected.

The Render Dockerfile mirrors the existing runtime image, with a dedicated
entrypoint. Keep the builder and runtime dependencies aligned when changing either
Dockerfile. The VPS image and its entrypoint are unchanged.

## State and model configuration

Postgres owns accounts, chat history, attachment metadata, and persisted task
state. S3 owns attachment bytes. The API currently runs database-backed background
workers in its own process; the OMP private service handles model-provider routing
and provider authentication, not general message delivery. Model credentials can
be configured through the existing provider setup. Built-in service agents use
the provider-neutral settings documented in [VPS deployment](vps-deployment.md).
No GCP service account is required for the core deployment.

Generated cursor, email-code, and provider-encryption secrets must survive
redeploys. Preserve them in an operator-controlled secret manager and back them up
separately from Postgres. Do not replace the Blueprint to rotate secrets casually.
The API has no persistent disk; data must not depend on its container filesystem.
OMP login sessions in progress are transient and may need restarting after a
provider-service restart. Saved provider credentials remain encrypted in Postgres.

The eventual primary and fallback domains must reach the same account database,
attachment bucket, and compatible secrets. A domain change alone cannot recover
an inaccessible old database. Do not direct product clients to this validation
database or merge old account records without a separate migration procedure.

## Acceptance gates

Use only disposable synthetic data. Do not call this deployment ready for users
until the following checks have passed against the deployed commit:

- Register two accounts using delivered email codes; sign out and sign back in.
  Test both configured OAuth callbacks and rejected/expired codes.
- Send messages between the accounts, reconnect realtime transport, fetch history,
  and verify ordering and visibility. Check forged forwarding headers cannot pick
  arbitrary rate-limit identities. Verify the real client address through Render's
  ingress before explicitly configuring trusted proxy ranges; do not trust every
  address to make this test pass.
- Upload, finalize, download, and compare a small attachment and a multipart
  attachment. Verify an unrelated account cannot fetch either object.
- Exercise a database-backed background task, restart the API, and confirm the
  persisted work completes without duplicate visible messages. Inspect task status
  and history rather than treating a healthy process as proof of delivery.
- Record account/message/attachment identifiers locally, redeploy the same API
  commit, and repeat login, history fetch, attachment digest checks, and background
  task observation. Keep test credentials and transcripts out of shared logs.
- In the isolated stack, interrupt a required dependency and confirm `/ready`
  returns 503, then restore it and confirm recovery. Restart NATS and verify the
  existing stream and persisted event survive. API event publishing currently logs
  failed publishes; it does not yet provide a transactional event outbox. Realtime
  reconnect/history recovery and task retry behavior therefore need explicit tests.
- Test a database restore plus matching attachment and encryption-secret recovery
  before using the stack for irreplaceable user data.

## Fly sandbox validation

This Blueprint intentionally contains no cloud-agent runner or sandbox executor.
The opt-in Fly adapter and separate runner deployment are described in
[Fly sandbox validation](fly-sandbox-validation.md). Validate the core gates first.
Scope tokens to a dedicated sandbox app. Sandboxes must not receive the
Postgres, Redis, NATS, SMTP, or object-store administration credentials.

Before enabling hosted Agent execution, validate cancellation of the owning
process tree, lease/retry behavior after runner and Machine restarts, workspace
persistence across stop/start, the policy for Machine replacement and volume
recovery, per-account isolation, and concurrency/spend limits. A running Fly
Machine alone does not establish any of these guarantees. Keep this work separate
from core Render readiness so unavailable sandboxes cannot be mistaken for a
working Agent service.

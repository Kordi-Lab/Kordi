# Service models on Google Cloud

Kordi Support and Grounding/System can use Vertex AI Chat Completions with
Google Cloud workload identity. Member-owned provider accounts are unaffected.
The two services keep their existing account and agent IDs, so switching the
provider preserves their conversations and ownership boundaries.

## Configuration

| Setting | Meaning |
| --- | --- |
| `KORDI_SUPPORT_ENABLED=true` | Enable Support; its existing owner email and inbox settings still apply |
| `KORDI_SUPPORT_PROVIDER=vertex-ai` | Select Vertex for Support |
| `KORDI_SUPPORT_VERTEX_MODEL` | Explicit supported Vertex Chat Completions model ID, including its publisher prefix |
| `KORDI_SYSTEM_AGENT_PROVIDER=vertex-ai` | Configure Grounding/System with Vertex |
| `KORDI_SYSTEM_AGENT_VERTEX_MODEL` | Explicit model ID for Grounding/System |
| `KORDI_SYSTEM_AGENT_ENABLED=false` | Disable both System and Grounding |
| `KORDI_SYSTEM_AGENT_GROUP_CHAT_ENABLED=false` | Keep Grounding enabled while disabling automatic group-plan runs |
| `KORDI_SERVICE_VERTEX_PROJECT` | Google Cloud project ID or number for model requests |
| `KORDI_SERVICE_VERTEX_LOCATION` | Model location; defaults to `global` |
| `GOOGLE_APPLICATION_CREDENTIALS` | Mounted workload identity credential configuration file |

Model IDs have no implicit default. Select a model supported by the chosen
Vertex endpoint and location, then verify inference and tool calls before
switching the services. This adapter uses the OpenAI-compatible protocol on
Google's endpoint; it does not send requests or credentials to OpenAI. Partner
models requiring a different API are not covered by this adapter.

Omitting the provider setting preserves legacy OpenAI configuration. Selecting
`vertex-ai` never falls back to a remaining OpenAI key or a member's saved
account. Once the switch is verified, remove the old service-key environment
references. Do not remove unrelated user credentials or OAuth sign-in settings.

## Workload identity

Follow Google's [Kubernetes workload identity guide](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-kubernetes):

1. Create a dedicated Kubernetes service account for the cloud server, with
   automatic Kubernetes API token mounting disabled.
2. Create a workload identity pool and OIDC provider trusting the production
   cluster's issuer and public JWKS. Restrict the provider to the exact server
   service-account subject. Keep development clusters and accounts separate.
3. Create a Google service account with only model invocation permissions
   (`aiplatform.endpoints.predict` and `serviceusage.services.use`). Grant the
   exact federated subject `roles/iam.workloadIdentityUser` on that account.
4. Create an `external_account` credential configuration using the standard
   `https://sts.googleapis.com/v1/token` endpoint, service-account impersonation,
   and a file-based credential source. Mount it read-only on the server.
5. Mount a projected Kubernetes service-account token with the provider's
   audience, a one-hour expiry, and the path named in the credential
   configuration. Set `GOOGLE_APPLICATION_CREDENTIALS` to the configuration
   file. The runner and route worker do not receive these mounts.

The server rejects personal ADC credentials and static service-account keys
for this mode. The official Google authentication SDK exchanges the projected
token and obtains a one-hour impersonated access token. Kordi recreates the
SDK credential cache after forty minutes so a token handed to the runner has
time to cover its ten-minute turn. No refresh credential goes to the runner.
Authentication errors omit provider response bodies and token values.

Uploaded JWKS must be updated when the cluster's signing keys rotate. Later
releases use the protected Deploy production workflow: it changes container
images only, preserving the server's service account, environment and volumes.
The legacy `deploy-cloud-server.sh` helper refuses to reapply its bootstrap
manifest when Google identity or imported service settings are configured,
before copying source, building images or changing any service. Never copy
production identity configuration or projected tokens to a development stack.

## Migration checks

Use the production deployment workflow's backup and restore verification before
schema changes. Validate the deployed product through its canonical origin.

- Confirm federation and impersonation from the production workload, and
  rejection of a different Kubernetes service account.
- Confirm model inference, streaming, and tool calls with synthetic inputs.
- Let active legacy service runs finish before switching their provider routes.
  Enable Support and Grounding/System with the selected model IDs; check both
  server replicas and all worker rollouts.
- Confirm the capability response advertises Grounding and the signed-in
  client's Grounding page loads. Exercise a private card build before matching
  or group automation. Enable group automation only within the authorized scope.
- Verify Support with an operator-owned conversation and retain existing
  account IDs, messages, and user provider connections.
- Remove legacy service-key references after the Google path passes. Keep
  deployment evidence free of credentials, private infrastructure identifiers,
  production messages, and unredacted logs.

Application version changes and public client releases are separate operations.

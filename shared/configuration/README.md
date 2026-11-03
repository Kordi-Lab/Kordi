# Shared backend configuration contract

Version 1 separates backend routing values from the public application's implementation. The public repository owns the schema, reference validator, TypeScript declarations, generator and synthetic fixtures. Each private ops repository owns its reviewed production backend assignment. This repository has no production assignment registry for the new contract.

This is the first step of configuration decoupling, not a complete edition or deployment system. The existing App and internal Beta launch/build paths, native identity checks, updater configuration and development safeguards are unchanged. Their historical constants remain until a later reviewed client-wiring migration. Nothing automatically loads an ops checkout, selects a backend, builds or deploys.

## Contract and trust boundary

`backend.schema.json` describes the structural format. `backend.mjs` is the reference validator and additionally enforces canonical HTTPS DNS origins and an independently supplied expected deployment target. JSON Schema validation alone does not authorize a target. Type declarations in `backend.d.mts` describe validated results; raw JSON must always pass runtime validation.

```json
{
  "schemaVersion": 1,
  "edition": "research",
  "environment": "production",
  "backend": { "origin": "https://research.example.test" }
}
```

The `.example.test` origins are synthetic. Real App and Research assignments belong in their respective private ops repositories. Native Beta is a development configuration, not a third hosted edition, and is deliberately rejected by this contract.

- Require an explicit expected `edition`, `environment` and `backendOrigin` from trusted ops policy. Do not derive them from the candidate being checked or accept them from an end user.
- Reject unknown or missing fields, unsupported versions, mismatched targets, credentials in URLs, noncanonical origins and loopback/local hosts. There is no default backend and no fallback between editions.
- Only HTTPS DNS origins are supported. DNS reachability and ownership are not checked; no network access occurs. Changing the trusted policy itself still requires review.
- Credentials, infrastructure identifiers, native bundle identity, updater keys, feature selection, models and resource policy are outside v1. Unknown fields in these categories are rejected, not silently passed through.
- Validated objects are detached, immutable values. Diagnostics omit candidate content and input paths.

## Validate without changing anything

Run from a pinned Kordi checkout. The example below deliberately uses synthetic values:

```sh
node scripts/backend-configuration.mjs \
  --config shared/configuration/examples/research.example.json \
  --edition research \
  --environment production \
  --expected-backend-origin https://research.example.test
```

For an actual release, use the reviewed file and expected target in the private ops repository. No private GitHub access is needed to validate the public examples or run the public tests.

## Generate explicit backend inputs

Add `--output-dir <new-directory>` to the same command. Its parent must exist; an existing destination is rejected. The command emits:

| File | Purpose |
| --- | --- |
| `backend.json` | Validated, allowlisted contract with stable field order |
| `desktop.env` | Existing `VITE_KORDI_CLOUD_API_BASE` input only |
| `runner.env` | Existing `KORDI_CLOUD_API_BASE` input only |
| `manifest.json` | Edition, environment, schema version and configuration SHA-256 |

Generated files are local build inputs, not source files. Keep them outside the public checkout or in ignored `.kordi-configuration/`. They are never sourced or executed automatically. A failed export must not be consumed; the manifest is written last. The digest checks identity of the configuration, not authorization or release signing.

The adapter uses existing variable names and exports no other settings. Consumers must deliberately apply only the appropriate input at their build/start boundary. Do not merge conflicting ambient backend variables or silently override a development profile. Existing developer launchers still own their loopback environment.

These outputs do not make an App binary into a Research binary. In particular, do not run a Research backend with an existing App or Beta native package. Research bundle IDs, callbacks, storage and updater isolation must land in the later native-client step before a Research build can be distributed. No iOS override is generated in v1.

## Compatibility and later work

The contract is additive and is not automatically consumed by current production or Beta entry points. Existing App defaults and Beta loopback behavior continue unchanged. New backend assignments are owned privately; removal of legacy literals and runtime cutover remain explicit follow-up work.

Later changes must extend the canonical contract with reviewed schemas and enforcement before moving feature/model/resource policy values out of Kordi. Keep authorization, validation bounds, migrations and quota enforcement in the shared core. Do not move secrets into either ops repository.

No deployment workflow, automatic promotion trigger, DNS setting, account migration or live environment is changed by this step.

## Validation

```sh
node --test scripts/backend-configuration.test.mjs scripts/backend-configuration-cli.test.mjs
```

The existing `pnpm test:scripts` hygiene check discovers these tests. They cover target mismatch, malformed and sensitive inputs, canonical origins, immutable results, deterministic generation, read-only validation and refusal to overwrite existing paths. Existing desktop origin tests remain the regression check for the unchanged App/development behavior.

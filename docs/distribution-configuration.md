# Ops-owned App and Research distributions

Kordi provides one implementation and a versioned distribution contract. Each private ops repository selects its backend, native identity, primary artwork, update trust, service policy, resource limits, and external signing bindings. A release has no implicit fallback to another edition. The existing internal Beta scheme and community development workflow remain separate.

## Ownership

| Public Kordi source | Edition ops repository | Restricted operator configuration |
| --- | --- | --- |
| Schemas, parsers, safe bounds, client allowlist | Reviewed profile and public backend origin | Actual cloud projects, regions, instances and service identities |
| App code, icon rendering and alternate icon components | Primary icon selection and source assets | Database and object-store bindings |
| Agent tools, plan-card protocol, support consent rules | Agent personas, names, model/provider selections | API keys, OAuth secrets and runner credentials |
| Non-root sandbox implementation and network restrictions | Sandbox backend, CPU/memory and runner capacity | Cluster credentials and image/namespace bindings |
| Generic build, signature and license verification | Bundle IDs, callbacks, updater public key, signing binding names | Apple certificates, private keys, provisioning profiles and Keychain profiles |

Client output contains only the public allowlist from `publicClientConfiguration`. Model/service settings, infrastructure bindings and signing references never enter it. Generated output is not a secret store and must not be committed.

## Prepare a profile

Use a clean source checkout at the exact revision pinned by the ops repository. Its wrapper supplies the expected edition, environment and backend independently of the profile. The shared loader rejects missing/unknown fields, target mismatches, Beta identity reuse, Research storage collisions, unsafe resource values, unsupported sandbox backends, and icon paths escaping the profile directory.

The underlying commands accept these explicit inputs:

```sh
export KORDI_DISTRIBUTION_PROFILE=/path/to/ops/config/distribution.production.json
export KORDI_EXPECTED_EDITION=research
export KORDI_EXPECTED_ENVIRONMENT=production
export KORDI_EXPECTED_BACKEND_ORIGIN=https://research.example.test
node scripts/prepare-distribution.mjs
node scripts/prepare-distribution.mjs --output-dir /path/to/new-build-inputs
node scripts/package-distribution.mjs desktop
node scripts/package-distribution.mjs ios
```

The example backend is synthetic; use the reviewed target from the selected ops repository. Validation and packaging plans do not build, sign, upload, provision or deploy. Preparation creates a new output directory exclusively and never overwrites an existing one.

Outputs include a contained profile/asset snapshot, `client.json`, `tauri.json`, `ios.xcconfig`, the selected icon assets, separate server/runner environment JSON, resource policy, Apple signing references, local-only iOS `ExportOptions.plist`, and a SHA-256 manifest. Absolute paths inside generated native build inputs are local-only and do not belong in Git.

## Client builds

Vite loads the selected profile at build time and injects only the public allowlist. Release API overrides must equal the selected origin. Generic browser builds have no product backend fallback; explicitly selected community browser fixtures remain loopback-only. Development/operator allowlists remain safeguards, not release defaults.

The desktop packaging wrapper uses one prepared snapshot for both native and web compilation and generates the Tauri identity, callback scheme, icons, updater endpoint and verification key. The native release embeds the selected backend at compile time, so a different launch environment cannot silently redirect the installed app. The App shipping identity is retained by its ops profile. Research has independent bundle/storage identity and cannot inherit App's updater key. Disabled Research updates provide no manual App download fallback.

The iOS `Kordi` scheme requires the App profile. `Kordi Research` requires the Research profile. Their settings come from the generated xcconfig and are checked against an embedded public identity record. The app and share extension validate the selected origin, callback, app group and credential service. `Kordi Beta` retains its exact existing bundle IDs, gray icon, callback, app group, keychain service and loopback origin; it does not load ops release settings.

To perform a separately authorized local build, add `--build`. iOS simulator validation also uses `--unsigned`. Desktop ad-hoc acceptance checks use `--unsigned --acceptance`; these are not distributable signed releases. Existing signature, Gatekeeper, license, checksum and version checks remain in the generic publication tools. Those tools now require the same ops selection; signing verification must use the edition's key.

## Server and sandbox consumers

For an already authorized environment, the process adapter selects only known service variables:

```sh
node scripts/run-configured-service.mjs server /path/to/kordi-cloud-server serve
node scripts/run-configured-service.mjs runner /path/to/kordi-cloud-agent-runner
```

This is a process launcher, not infrastructure provisioning. Do not run it against a live environment without that environment's operating authorization. The server receives the selected public origin, client callback allowlist, model/provider policy, built-in personas, names and connector budget. The runner receives the backend, polling, concurrency, sandbox backend and bounded Kubernetes CPU/memory limits. The configured launcher requires explicit namespace/image bindings for Kubernetes or the required Fly bindings; release runners reject an implicit local sandbox. Credentials and restricted bindings are supplied separately through the established service-specific environment variables. The profile cannot turn off authorization, change cross-user boundaries, enable privileged containers or attach service-account credentials to sandbox pods.

Ops owns the resource plan and provider choice. Its binding fields are environment-variable names, not actual identifiers. Kubernetes namespace/image, Fly app/image/token, database, storage, IAM and GCP placement must be resolved by the separately reviewed deployment adapter. This implementation does not provision those resources, change existing deployments or replace network policy.

Built-in agent persona text is selected once at startup and combined with the shared core protocol. The existing development persona is retained only in debug builds; a release-enabled agent requires an explicit persona. Existing agent IDs remain stable within each independent database, avoiding duplicate built-ins or account migrations.

## Apple release boundary

The selected profile records the signing-team, signing-identity and notary-profile binding names and the iOS export method. Planning does not read their values. An explicit signed build resolves the team and identity from restricted environment/Keychain configuration. Certificates, private keys, provisioning profiles, passwords and actual team IDs never belong in either ops repository.

The packaging command builds locally. Archive export, notarization, App Store/TestFlight submission, release publication and deployment remain explicit release operations. Use the selected export method and notary binding when performing those operations; their credentials are not inferred from another edition. Before publication, verify the actual bundle identifier, signature, entitlements, update key and backend against the selected profile, and retain artifact/config/source provenance.

## Validation and rollout

CI uses synthetic profiles and disposable fixtures. It does not require access to either private ops repository. Ops CI checks a clean pinned public checkout and validates its real profile without signing or deploying.

This change does not migrate accounts, sessions or data, implement Research admission, rotate keys, register Apple identities, provision GCP resources, change DNS, or deploy. Research's updater remains disabled until an independent key is reviewed. Resource sizes in ops are proposed bounded selections; they are not claims about live capacity. Live App parity and a staged Research rollout require a separate authorized release procedure.

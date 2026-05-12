# Cloud account auth foundation

- Added production cloud account schema foundations to the Bridges server database:
  - `cloud_accounts`
  - `cloud_account_identities`
  - `cloud_devices`
  - `cloud_refresh_tokens`
  - `cloud_audit_events`
- Added optional `account_id` / `device_id` linkage on `registered_nodes` so Bridge node credentials can be scoped under a human account and device.
- Added an extensible OAuth provider registry foundation for GitHub, Google, and X, including provider-id normalization.
- Added account identity, account profile update, and device registration helpers for future OAuth login endpoints.
- Account profiles can store user-set display names and avatar URLs.
- Kept existing node API-key registration compatible; account/device linking is optional until cloud login is wired into desktop.

Non-goals for this change:

- No external OAuth browser flow yet.
- No desktop account-login UI yet.
- No cloud message sync protocol yet.

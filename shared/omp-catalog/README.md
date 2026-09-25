# OMP provider catalog

`omp-provider-catalog.json` is a pinned, checked-in snapshot of the oh-my-pi (OMP) provider
catalog from `@oh-my-pi/pi-catalog@18.2.11`. It lists every provider OMP bundles, each with
its id, display name, default model, endpoint, auth method, login policy, and text-model IDs, so the
desktop app, iOS app, and offline previews can load the full provider list without a backend
or network call. It also lists login-only providers that OMP omits from its bundled
model-provider list but that add accounts for a listed provider (currently
`openai-codex-device`, which stores its credential as `openai-codex`); these rows have no
models.

## Regenerating

The snapshot is produced by `experiments/omp-provider-routing/export-catalog.ts`, which reads
`bundledProviderCatalog()` from `experiments/omp-provider-routing/live-server.ts` and the
pinned `@oh-my-pi/pi-catalog` version from that package's installed `node_modules`. To
regenerate after bumping the pinned dependency:

```sh
cd experiments/omp-provider-routing
bun install
bun run export-catalog
```

Commit the resulting change to this file. `experiments/omp-provider-routing/catalog-sync.test.ts`
rebuilds the catalog in memory from the installed dependency and fails if it no longer matches
this file, so a version bump without re-running the export is caught by `bun test`.

## Endpoint

Each provider has top-level `baseUrl` and `api` (both `string | null`): the base URL and OMP
transport `api` kind (for example `openai-completions`, `anthropic-messages`) that a claimed
credential for the row is used against. They come from the provider's default bundled text
model (for a login-only row, from the provider it stores credentials under). `baseUrl` is
`null` when OMP only has a template (such as a `{region}` or `<account>` placeholder) or a
non-https scheme, so no client or runner ever guesses a host. The hosted worker stamps the same
pair onto claimed login material, replacing it with a login-chosen endpoint (a custom base
URL, region, or enterprise domain) only when that endpoint passes the worker's outbound guard.

## Source of truth

This catalog is the source of truth for OMP provider IDs, display names, model IDs, and auth
methods (`kind`, `acceptsApiKey`, `instructions`, `authUrl`, `placeholder`, `envVars`) across
Kordi clients. Kordi's own local provider definitions should not redeclare or override any of
that — they only add Kordi-specific concerns on top: saved accounts (credentials, profiles) and
interactive sign-in adapters (OAuth flows, paste-key UI) that drive the auth method this catalog
already describes.

## Login policy

Each provider carries a `login` object projected from OMP's compiled auth policy
(`@oh-my-pi/pi-catalog/compat/rules.json`, `.auth.providers`) by
`experiments/omp-provider-routing/login-policy.ts`. Clients use it to present the provider's
own sign-in steps; the hosted worker's `/login/*` routes (`login-sessions.ts`) run them.

| Field | Meaning |
| --- | --- |
| `kind` | `api-key`, `oauth-code`, `device-code`, `custom`, or `env-only` (OMP declares no login rule and reads a key from the environment; hosted Kordi accepts a pasted key). |
| `name` | OMP policy display name. |
| `instructions` | Instructions from the `api-key`, `oauth-code`, or `device-code` rule, or `null`. Device-code text keeps the literal `{user_code}` placeholder. |
| `prompt` | `api-key` prompt, or `null`. |
| `placeholder` | `api-key` input placeholder, or `null`. |
| `authUrl` | `api-key` console page, or `null`. |
| `validates` | The `api-key` rule probes the provider before accepting the key. |
| `pasteKey` | The `oauth-code` rule also accepts a pasted API key in place of a code. |
| `manualOnly` | The `oauth-code` rule never listens for a loopback callback. |
| `callbackPort` | `oauth-code` loopback callback port, or `null`. |
| `callbackPath` | `oauth-code` loopback callback path (such as `/auth/callback`), or `null` for manual-only and other kinds. |
| `hook` | OMP hook that implements a `custom` login, or `null`. |
| `apiKeyFormat` | `bearer` or `structured`, or `null`. |
| `envVars` | Environment variables OMP reads for the provider. |
| `storeCredentialsAs` | Provider ID the credential is stored under when it differs from the login ID, or `null`. |
| `acceptsApiKeyMethod` | The provider also takes a pasted API key (`method: "api-key"` on the worker's `/login/start`): always for `api-key`; for `env-only` when `envVars` is non-empty and the provider does not authenticate natively (AWS credential chains for Bedrock); and for `oauth-code`, `device-code`, or `custom` when `pasteKey` is true or an `envVars` entry ends in `_API_KEY`. |

`acceptsApiKeyMethod` is one shared rule (`acceptsHostedApiKey` in `login-policy.ts`). The
worker's `/login/start` and `/validate-key` enforce it, and the catalog derives `auth.acceptsApiKey`
from it (always equal) and `auth.kind` from the login kind, with `env-only` shown as `api-key`
when the rule accepts a key and `native` otherwise. Every provider's `login` object has the same
16 keys.

The projection never copies client IDs, client secrets, token or refresh endpoints,
credential maps, or userinfo settings from the compiled rule.

This file contains no credentials. `export-catalog.ts` asserts that no string value in the
output looks like an embedded API key or token before writing it.

## English-only display text

`catalog-builder.ts` strips non-Latin-script parenthetical and trailing segments from
`name`, `auth.name`, `auth.instructions`, `auth.placeholder`, `login.name`,
`login.instructions`, `login.prompt`, and `login.placeholder` (for example, an upstream
display name that ends in a parenthesized native-script alias has that alias segment
removed here), falling back to the provider id if that would empty a value. This keeps the
checked-in snapshot compliant with the repository's English-only rule
(`scripts/check-english-only-diff.sh`) without touching provider ids, models, or auth
mechanics, which are passed through unchanged.

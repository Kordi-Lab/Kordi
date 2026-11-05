# Managed devices

An organization can pin the Kordi apps on its managed devices to its own
accounts. The policy comes only from the device's management system (an MDM
profile on macOS, Managed App Configuration on iOS). The apps never read it
from a server response, so a server cannot loosen it.

## Keys

| Key | Value | Meaning |
| --- | --- | --- |
| `allowed_sign_in_methods` | array of `google`, `github`, `email` | Sign-in methods the app offers. `email` covers password sign-in, sign-up and email codes. |
| `allowed_organizations` | array of organization ids | The signed-in account must be an active member of one of them. An entry is a configuration id from the organizations file (for example `example-university`) or a server organization id (`org_...`). |

Rules shared by every app:

- A missing key does not restrict anything.
- A present key restricts to its valid entries. Unknown entries are ignored,
  so a key with no valid entry allows nothing (fail closed). A value that is
  not an array of strings counts as a key with no valid entry.
- Entries are trimmed. Method names are compared in lowercase; organization ids
  are compared exactly.

### macOS

Domain `ai.kordi.desktop`, delivered by a configuration profile
(`com.apple.ManagedClient.preferences` payload or a custom settings payload for
that domain). The app reads a key only when the system reports it as forced
(`CFPreferencesAppValueIsForced`), so a value a user writes with `defaults
write` is ignored. The domain is the same for every desktop build.

Example payload content:

```xml
<key>allowed_sign_in_methods</key>
<array><string>google</string></array>
<key>allowed_organizations</key>
<array><string>example-university</string></array>
```

### iOS

The same keys inside the Managed App Configuration dictionary
(`UserDefaults` key `com.apple.configuration.managed`). Only the `Kordi Beta`
app (bundle `ai.kordi.ios.beta`) reads it for now; the production app ignores
it until the beta has been tested.

## Where the apps enforce it

1. **Sign-in start.** Disallowed methods are not shown, and a disallowed
   method is refused before any request ("This device does not allow this
   sign-in method."). When every method is disallowed the sign-in screen offers
   nothing and says "This device does not allow any sign-in method." The first
   allowed organization is sent as a hint (below).
2. **Callback.** After a sign-in returns a session, the app loads the
   account's organizations before it keeps the session. An account that is not
   an active member of an allowed organization is refused: the app revokes the
   new session, keeps nothing, and shows "This device only allows accounts
   from your organization." If the check cannot be made, the sign-in fails with
   "Could not check your organization. Try again."
3. **App start and token refresh.** The same check runs when a saved session
   is restored and after every refresh. When the server answers and the account
   no longer qualifies, the app signs out locally and shows "You were signed out
   because this device only allows accounts from your organization." A network
   error keeps the session and checks again at the next start or refresh.

### Membership check

`GET /v1/cloud/account/organizations` with the session bearer. The account
qualifies when either holds:

- an entry of `organizations[]` has `organizationId` in the allowed list, or
- an entry of `configured[]` has `admission` equal to `member` or `reverify`,
  and its `id` or `organizationId` is in the allowed list.

## Hints sent to the server

Hints only shape the sign-in page; they never relax anything.

- OAuth start (`GET /v1/cloud/auth/oauth/:provider/start`):
  `organizationHint=<id>`. When it names an open configured organization and
  the provider is Google, the server adds Google's `hd` parameter for that
  organization's domain (only when it has exactly one claimed domain).
- Browser sign-in (`GET /v1/cloud/auth/app/authorize`): `organization_hint=<id>`
  and `sign_in_methods=<comma list>`. Valid values are forwarded to the sign-in
  page, which should open on that organization and offer only those methods.
  The page is outside this repository; until it reads them, the app's
  callback check is what enforces the organization.

Invalid hint values are dropped, never rejected.

# Multi-instance desktop launcher

Phase 2 adds a config-driven launcher for isolated desktop dev instances.

## Config

Edit `configs/users.yaml`.

Example:

```yaml
defaults:
  host: 127.0.0.1
  titlePrefix: Kordi
  dataRoot: ../../../.multi-instance-data
  logsRoot: ../../../.multi-instance-logs
  runtimeRoot: ../../../.multi-instance-runtime
  bootstrap:
    authSource: shared
    authMode: if-missing

users:
  - id: user1
    port: 1482

  - id: user2
    port: 1484
    bootstrap:
      authFile: ./local/user2-auth.json
      authMode: always
```

By default, `authSource: shared` copies your existing shared desktop/CLI auth store from `~/.kordi/auth.json` (or legacy `~/.bb-agent/auth.json`) into each isolated instance, so you do not need to re-auth every time.

You can still override a specific user with `authFile` to point at a local `auth.json`-compatible fixture. Keep real secrets in local-only files, not committed source.

- `authMode: if-missing` seeds auth only for a fresh instance
- `authMode: always` overwrites the target auth store on every launch
- configure only one of `authSource` or `authFile`

## Launch

```bash
pnpm dev:desktop:multi -- --users user1,user2
```

## Launch from clean state

```bash
pnpm dev:desktop:multi -- --reset --users user1,user2
```

## Reset only

```bash
pnpm reset:desktop:multi -- --users user1,user2
```

## Run the two-user smoke test

```bash
pnpm smoke:desktop:multi -- --users user1,user2
```

By default this will:
- reset both users
- re-seed auth from shared bootstrap
- launch both instances
- wait for redacted readiness signals from auth/runtime/log artifacts
- stop the instances again while preserving logs and data

Keep the instances running after verification:

```bash
pnpm smoke:desktop:multi -- --users user1,user2 --leave-running
```

## Inspect config resolution

```bash
pnpm dev:desktop:multi -- --dry-run
```

## Output paths

- data: `app/desktop/.multi-instance-data/<id>/`
- logs: `app/desktop/.multi-instance-logs/<id>/dev-<port>.log`
- runtime files: `app/desktop/.multi-instance-runtime/<id>.pid|json`

## Bootstrap behavior

When a user has bootstrap auth configured, the launcher copies the resolved auth store into:

```text
app/desktop/.multi-instance-data/<id>/kordi/auth.json
```

This happens:
- on first launch when the target auth store is missing
- or on every launch if `authMode: always`
- or after `--reset`, which clears the instance first and then reapplies bootstrap

The launcher prints only redacted provider summaries, not credential values.

## Smoke test readiness checks

The smoke test currently verifies, for each user:
- the isolated auth store exists and contains at least one provider
- runtime metadata exists and matches the configured user/port
- the detached process is alive
- the per-user log contains the expected profile startup markers

If verification fails, it prints the affected auth/log/runtime paths so you can inspect the preserved artifacts directly.

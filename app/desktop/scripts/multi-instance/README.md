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

users:
  - id: user1
    port: 1482
  - id: user2
    port: 1484
```

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

## Inspect config resolution

```bash
pnpm dev:desktop:multi -- --dry-run
```

## Output paths

- data: `app/desktop/.multi-instance-data/<id>/`
- logs: `app/desktop/.multi-instance-logs/<id>/dev-<port>.log`
- runtime files: `app/desktop/.multi-instance-runtime/<id>.pid|json`

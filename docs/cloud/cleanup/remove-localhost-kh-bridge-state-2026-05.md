# Remove localhost kh Bridge state from Cloud cleanup notes

This cleanup supports issue #449. It must run only after the Cloud client no longer reads localhost Bridge rows for Cloud collaboration.

## Dry run

```bash
kubectl -n kordi-cloud exec postgres-0 -- psql -U kordi -d kordi_cloud -P pager=off -f bridges/cloud-server/scripts/dry-run-localhost-kh-cleanup.sql
```

## Backup before delete

Use timestamped backup tables before deleting any rows:

```sql
CREATE TABLE incident_202605_issue449_legacy_messages AS
SELECT now() AS backed_up_at, m.*
FROM cloud_messages m
WHERE false;

CREATE TABLE incident_202605_issue449_legacy_sync_events AS
SELECT now() AS backed_up_at, e.*
FROM cloud_sync_events e
WHERE false;
```

## Delete policy

Delete only rows matching reviewed predicates and only after recording dry-run counts in the PR. Do not delete account records, refresh tokens, device keys, or Cloud session activity rows.

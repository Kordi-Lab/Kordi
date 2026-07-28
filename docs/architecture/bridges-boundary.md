# Cloud and standalone Bridges boundary

This document records the ownership and compatibility boundary introduced by
#749. It prevents the historical `bridges/` directory name from being treated
as one runtime or product.

## Runtime ownership and disposition

| Component | Product role | Owner | Disposition |
| --- | --- | --- | --- |
| `bridges/cloud-server` | Hosted authentication, collaboration, sync, updates, and runner coordination | Kordi Cloud service maintainers | Core Cloud service. Keep independently buildable and deployed. |
| `bridges/cloud-agent-runner` | Hosted model loop, tools, sandbox policy, and artifact execution | Kordi Cloud service maintainers | Core Cloud service. Keep independently buildable and deployed. |
| `bridges/cloud-temporal-bridge` | NATS-to-Temporal workflow adapter | Kordi Cloud infrastructure maintainers | Keep in place until its deployment owner and live usage are verified; rename separately if warranted. |
| `bridges/cli` | Standalone local/P2P daemon and self-hosted coordination client | Kordi-Lab repository maintainers, pending a dedicated standalone-product owner | Retained as an explicit standalone surface. It is not built, bundled, launched, or supported by Kordi Desktop. |
| `bridges/registry` | Standalone TypeScript node/project registry | Kordi-Lab repository maintainers, pending an external-deployment audit | Archive candidate. Do not remove until external deployments are checked. |
| `bridges/skills/bridges` | Instructions for runtimes using the standalone CLI | Same owner and lifecycle as `bridges/cli` | Retained for the standalone surface only; not a Desktop dependency. |

No removal or support promise for the standalone network is implied by this
change. A later decision must name a dedicated owner, release contract, and
test surface, or document an external-usage audit and deprecation plan.

## Desktop runtime boundary

The Cloud desktop talks directly to the hosted API. Its development and release
paths:

- build and package only the Kordi agent runtime sidecar;
- do not compile, copy, sign, package, or launch `bridges/cli`;
- do not create or manage a native local/P2P Bridge manager;
- do not register local Bridge configuration, discovery, mailbox, realtime,
  project, contact, or server commands.

The desktop collaboration read model is transport-neutral. The Cloud adapter is
implemented by `cloudCollaborationState.ts` and
`useCloudCollaborationState.ts`; common UI helpers live under
`features/collaboration`.

Active models use neutral fields such as `sourceHostId`, `sourceIdentityId`,
`sourceConversationId`, and `sourceRequestId`. Newly written collaboration
targets use `agent` and `person`; newly written canonical identity sources use
`cloud`.

## Stored identifier compatibility

New direct Cloud conversation identifiers use:

```text
cloud:conversation:<encoded-account-id>:<person|agent>
cloud:conversation:<encoded-account-id>:<person|agent>:session:<encoded-session-id>
```

The parser in `features/collaboration/conversationIds.ts` continues to accept
the historical forms:

```text
bridge:cloud:<account-id>
bridge:cloud:<account-id>:person
bridge:cloud:<account-id>:session:<encoded-session-id>
session:bridge:...
```

Historical `bridge_*` database columns remain compatibility schema. The native
canonical boundary serializes them with neutral wire names and accepts the old
camel-case names as deserialization aliases. Stored metadata and message
content are normalized by
`features/collaboration/legacyBridgeCompatibility.ts`. Those compatibility
paths do not imply that the local Bridges runtime is present. Removing or
renaming the database columns requires a separate migration with rollback and a
defined compatibility window.

Regression tests must prove both sides of the contract: new IDs are neutral,
and old IDs remain readable.

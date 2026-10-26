# Grounding Nearby validation: issue 2100

Validation date: 2026-10-26. Baseline: main at `a4003dce6`, including Nearby (#2124), Contacts entry recovery (#2102), and reciprocal card sharing (#2115).

This record separates automated checks from physical-device acceptance. Passing a simulator test does not establish background scheduling or APNs delivery on a physical iPhone.

## Findings

The baseline passed 111 focused desktop tests, 81 native iOS tests on a dedicated simulator, and 126 Grounding server tests with a disposable PostgreSQL database. The server suite exercises the real router and database with synthetic signed-in accounts. Model responses are deterministic fixtures, and the alert tests do not connect to APNs.

A new negative test reproduced a missing evidence constraint: a candidate with `Fudan` only in Interests could satisfy a model verdict that they were a Fudan alum. The existing test named `a_topic_alone_never_proves_willingness_or_affiliation` did not actually put the affiliation evidence in Interests, so it missed this case.

The follow-up requires affiliation evidence in the shared profile name or focus, rather than accepting a card topic. The prompt describes the same restriction. A two-account regression covers person results, alert queueing, and delivery revalidation of a verdict stored under the previous rule. This is deliberately conservative: affiliation recorded only in an untyped card topic remains unknown. Live model quality still needs validation; matching a source string does not independently prove the semantic claim.

After the fix, all 128 Grounding server tests passed against the disposable database. Cloud-server all-target Clippy with warnings denied and repository hygiene checks also passed.

## Acceptance evidence

| Issue criterion | Evidence | Remaining qualification |
| --- | --- | --- |
| Contacts entry with zero contacts, no search results, capability failure/recovery, and unsupported service | Desktop `commonGroundEntry.test.tsx` passes, including retry after cached success. | Automated component coverage. |
| Nearby inside Grounding > Pair alongside existing methods | Desktop Nearby screen tests and native Grounding wallet tests pass. | Automated placement coverage. |
| Range and score boundaries | Database `range_and_minimum_score_filter_and_order`; distance unit tests; desktop and iOS filter tests pass. | Deterministic stored scores; not a live model-quality evaluation. |
| Two-account reciprocal participation and consent | Database cases cover off, pause, sharing withdrawal, stale locations, sign-out, revoked devices, actions, and room links that cannot substitute for Nearby consent. Desktop state tests and iOS withdrawal tests pass. | Current-run native tests exercise rules and clients, not a physical two-phone UI flow. |
| Custom needs, expiry, and obsolete alerts | Database request revision, expiry, pause, deletion, ownership, and evidence tests; new school-interest regression. | Apply the follow-up fix; evaluate actual model-generated conditions and evidence in a connected development environment. |
| Physical background discovery and notifications | Native rules cover Always/When In Use, refresh availability, precise-location withdrawal, status labels, and push payload routing. | **Not complete:** actual background execution, permission changes while suspended, and APNs receipt/tap on physical devices. |
| Alert deduplication, frequency, and delivery rechecks | Database cases cover one alert per request revision, weekly match deduplication, daily cap, quiet gap, expiry, and consent/request/score revalidation. | APNs transport delivery is not covered by these database tests. |
| Existing room matching, proximity, QR, and short-code pairing | Full Grounding database suite plus 12 native pairing tests cover exchange, code redemption, deep links, range/fallback rules, and errors. | Physical proximity radio exchange and camera QR scanning still need device checks. |

## Environment limits

The connected physical iPhone had Developer Mode enabled. The approved Beta environment uses a loopback API intended for simulators; the physical phone cannot reach the Mac through its own loopback address. See [Native iPhone environments](../development-environments.md#native-iphone-environments). No production deployment, production account mutation, or production notification test was performed.

The approved shared development connection could not start because its Google Cloud session required reauthentication. The isolated database validation does not depend on that connection and does not use or reset persistent development accounts.

## Reproduction

Use an isolated disposable PostgreSQL database and set `DATABASE_URL` in the local shell. Do not use a shared or production database. The server fixtures initialize migrations and create synthetic accounts.

```sh
cargo test -p kordi-cloud-server --lib common_ground:: -- --test-threads=1
(cd app/desktop && pnpm exec tsx --test --test-concurrency=1 \
  tests/commonGround*.test.ts tests/commonGround*.test.tsx \
  tests/contactCommonGroundMatch.test.tsx)
```

Create a task-owned simulator and use its identifier in `IOS_SIMULATOR_ID`:

```sh
xcodebuild -project app/ios/Kordi.xcodeproj -scheme 'Kordi Beta' \
  -destination "platform=iOS Simulator,id=$IOS_SIMULATOR_ID" \
  -derivedDataPath .build/grounding-validation \
  -parallel-testing-enabled NO \
  -only-testing:KordiTests/CommonGroundNearbyTests \
  -only-testing:KordiTests/CommonGroundPairingTests \
  -only-testing:KordiTests/CommonGroundTests \
  -only-testing:KordiTests/CommonGroundWalletTests \
  -only-testing:KordiTests/CommonGroundProfileTests \
  CODE_SIGNING_ALLOWED=NO test
```

## Physical-device exit checklist

Keep #2100 open until an explicitly approved device/backend setup is available and the following evidence is recorded:

- Two dedicated accounts; client build and deployed backend revision identified.
- Real notification registration and receipt, followed by tapping into the correct Nearby person.
- Always location with Background App Refresh enabled: background the app, move enough to trigger a location event, and observe a fresh server location and eligible alert.
- Deny/revoke permission, disable precise location or background refresh, stop discovery, and sign out: verify truthful UI status and no new search results or eligible alerts after withdrawal reaches the server.
- Suspend or force-quit without another location update: verify location freshness expires and no new alerts are delivered for stale presence. Do not promise uninterrupted discovery.
- Confirm request edits/expiry and repeated matches on real devices without duplicate notifications.
- Exercise existing phone proximity exchange and camera QR/short-code pairing.

Record what actually happened, including OS scheduling delays and cases the OS did not run. Simulator location injection, push injection, and direct invocation of a background callback must be labeled as simulations.

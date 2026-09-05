# Rolling digest system preview

This fixture exercises the actual desktop Digest component, authenticated Cloud API, background digest worker and read-only agent runner. It does not replace model output with a reference summary. Without a connected developer-owned model, generation is blocked and the evaluation must not be reported as passed.

Use a dedicated development stack and database with generated credentials. Never seed a shared stack, reuse another task's ports, import production data, or publish the API/database publicly. Resolve host and port authorization under the development environment instructions before deployment. Keep target values, generated credentials, session tokens and captured account state in ignored local task files.

## Scenarios

`scenarios.json` contains four synthetic conversations and thirteen messages. Taylor can read three rooms; the fourth contains a private canary. Phase 0 has eight accessible messages, and phase 1 adds four updates:

- A launch review is confirmed for tomorrow at 14:00 Riyadh time, then moved to 15:30.
- Alex promises release notes by 18:00 tomorrow, then reports them completed.
- Copy review has no agreed owner or exact deadline.
- A vendor document blocks security review; its arrival resolves that blocker, but approval remains pending.
- A quoted malicious prompt must remain evidence, not instructions.
- The private room and its canary must never enter Taylor's digest or evidence.

All people and messages are fictional. Relative-date expectations use the preparation time saved in the manifest. Reuse the same manifest across phases.

## Run

1. Deploy the branch's server, runner and migrations to the task-owned stack. Create the synthetic viewer through normal signup with an address ending in `@digest.example`; store generated login details only in an ignored task file.
2. Generate phase 0 using the returned viewer account ID:

```sh
python3 scripts/digest-system-eval.py prepare \
  --viewer '<SYNTHETIC_ACCOUNT_ID>' --phase 0 \
  --sql .build/digest-fixture.sql --manifest .build/digest-manifest.json
```

3. Apply that SQL inside the dedicated database container. This inserts only synthetic accounts, conversations and messages. Repeating a phase is idempotent.
4. Connect a developer-owned model through the normal app provider settings. Do not put a key or subscription session into fixture files or logs.
5. Launch the approved remote desktop wrapper with task-owned target variables, API/UI ports and a unique profile. Set `KORDI_DEV_PREVIEW_PATH=/tests/visual/rollingDigestPreview.html` to open the actual digest component in its synthetic test harness. The harness accepts only development loopback APIs and synthetic email addresses. It requires normal authenticated login.
6. Opening Digest enables the background monitor. Wait for a ready snapshot and save the authenticated JSON response to an ignored file without logging the bearer token. Capture generation latency separately.
7. Evaluate that response:

```sh
python3 scripts/digest-system-eval.py evaluate \
  --response .build/digest-response.json --manifest .build/digest-manifest.json \
  --output .build/digest-evaluation.json
```

8. Prepare/apply phase 1 with the same manifest. Wait for the background worker to update the digest without pressing Refresh, then capture/evaluate the new response. Do not clear the previous snapshot: this checks rolling reconciliation.
9. Manually check claim entailment, omissions, security approval wording, source excerpts, contact attribution, stable tab switching and the latest calendar proposal. Confirm an event, edit its reminder, import the same ICS twice, and check that event identity remains stable. Test native calendar/notification permission and reminder delivery separately on the relevant platform.

The evaluator reports individual contract and scenario checks, not a single model-quality score. A missing snapshot is a failure to run the evaluation. Its self-test deliberately plants an inaccessible source and a guessed deadline to verify that regressions are caught:

```sh
python3 scripts/digest-system-eval.test.py
```

The HTML harness renders the desktop implementation. For native iOS system testing, use the Kordi Beta scheme against the same isolated API and synthetic account; resizing this harness is not an iOS implementation test.

## Additional event conversations

`more-event-messages.json` adds 24 fictional messages across the three visible test conversations. They cover confirmed meetings, rescheduling, a location change, a cancelled meeting, a New York/Riyadh time conversion, overlapping bookings, preparation tasks, a date-only deadline and an unconfirmed invitation. Stable client message IDs and reply references allow publication through the normal chat API without duplicating a retried batch. These are conversation fixtures, not pre-created calendar events.

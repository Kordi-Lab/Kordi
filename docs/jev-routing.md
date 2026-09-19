# Jev routing for PiP and Digest

Tracks #1601. The implementation targets the current PiP group-plan agent and the rolling account Digest, which already has incremental generation. It preserves their existing scheduling and source authorization; it does not introduce a Daily/Weekly report mode.

## Routes

PiP evaluates new-message-only sweeps. Jev can recommend silence, the existing planner, or a plan-card action. The latter is a hint to the generative planner: Jev never supplies executable arguments or performs a plan-card mutation. All six card operations remain available and every actual mutation still goes through the run-bound server endpoint. Card-change and reminder hooks bypass evaluation so they cannot be swallowed as irrelevant chat.

Digest evaluates only complete incremental inputs containing new version-1 messages and no structural changes. It can return an empty patch to reuse content, prefetch `read_session` for an enumerated authorized session, prefetch `search_sessions`, or use baseline generation. The first generative call receives the selected observation, avoiding a model turn just to request that tool. Prefetch consumes the existing tool budget; oversized or failed observations fall back to the unchanged input and tool catalog. There is at most one evaluation and one prefetch per run, with no recursive evaluation loop.

Full reports, partial coverage, edited or removed sources, changed preferences, tasks, calendars and due reminders always use baseline generation. Uncertain decisions do too. Skipped Digest generation still passes through server patch merging, output validation and current source-access checks. A successful no-op updates the frozen evidence and revision without changing `updatedAt` when content is identical. The additive `checkedThrough` response field reports the saved input's `asOf`; it is distinct from content age and is not a claim of complete historical coverage.

## Configuration

Both features default to **off**. Configuration is read once per runner process; restart that runner to change modes or rotate the evaluator key.

| Variable | Values / behavior |
| --- | --- |
| `KORDI_JEV_PIP_MODE` | `off`, `shadow`, `enabled`; missing or unrecognized values mean off |
| `KORDI_JEV_DIGEST_MODE` | Independent `off`, `shadow`, `enabled` switch |
| `KORDI_JEV_PROVIDER` | `typesafe` (default) or `vercel`; unknown providers fail back to generation |
| `KORDI_JEV_API_KEY` | TypeSafe credential, used only by the TypeSafe transport |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway credential, used only by the Vercel transport |
| `KORDI_JEV_MODEL` | Defaults to `jev-1.13` for TypeSafe, `typesafe-ai/jev` for Vercel |

Shadow mode calls Jev and records the proposed route but runs the original generation path without applying tool selections or skips. It sends the same eligible context to the evaluator as enabled mode; use synthetic isolated inputs for initial validation. Disabled mode makes no evaluator requests. Missing credentials fall back to generation.

The native Rust adapter supports TypeSafe's documented `POST /v1/systemone` and Vercel's experimental v4 evaluation transport at `/v4/ai/evaluation-model`. The latter mirrors the official AI SDK's `gateway-evaluation-model.ts` and authentication headers; it is not an OpenAI chat-completion endpoint or a stable documented REST API. Contract tests cover its headers, boolean translation, response distributions and token usage. It needs no JavaScript service. Model aliases and experimental protocol changes require revalidation before rollout.

Vercel omits TypeSafe's separate confidence value. The adapter preserves that absence rather than fabricating confidence. Gateway skips require selected probability of at least 0.995, and tool recommendations require 0.95. Missing distributions, unexpected warnings or invalid replies fall back to generation. These thresholds need independent calibration.

## Bounds and isolation

- At most 16 typed questions, 64 choice options, and 48 KB serialized state plus questions. These byte limits are conservative request budgets, not tokenizer measurements. Oversized state falls back without silently pruning evidence.
- Digest includes the complete delta, baseline, calendar index, session directory and surrounding source messages from changed sessions. PiP uses its existing bounded snapshot.
- A two-second routing deadline includes semaphore waiting, requests and backoff. Four concurrent evaluations are allowed per runner process. Dropping a run cancels its in-flight evaluation future.
- The HTTP client disables redirects, limits responses to 64 KB, and retries a transient status once with a short backoff. A longer `Retry-After` falls back immediately. Provider bodies, credentials and URLs are not included in errors.
- Three consecutive failed evaluations open a 30-second circuit. Success resets it. A process-local cache holds at most 128 results for 60 seconds and stores hashes plus bounded typed answers, not source messages.
- Cache keys include owner, requester, session, full frozen input, system instructions, questions, rubric version and configured model. Edits, membership/source-scope changes represented in a new snapshot, clock changes and card revisions produce different keys. Cache hits do not bypass server authorization at completion.
- A skip initially requires both selected probability and confidence of at least 0.98. Tool routes require 0.90. These are conservative experimental settings, not calibrated accuracy guarantees.

Routing logs contain consumer, mode, proposed/applied route, reason, elapsed time, cache hit and reported token usage. They omit source text and identities. Cached decisions report zero new usage; failed requests may have incurred provider cost that was not returned. Provider billing remains authoritative for total cost.

## Validation and rollout

```sh
cargo test -p kordi-cloud-agent-runner
cargo test -p kordi-cloud-server --lib digest:: -- --skip postgres
```

The existing `digest::tests::postgres_scope_and_atomic_publication` fixture additionally verifies that a no-op patch preserves content time and advances its evidence snapshot. It requires a fresh task-owned PostgreSQL database via `KORDI_DIGEST_TEST_DATABASE_URL`.

An explicitly opted-in live evaluation command sends only its built-in synthetic fixtures:

```sh
cargo run -p kordi-cloud-agent-runner --example evaluate_jev_routes -- --live
```

For a local Vercel test with the saved macOS Keychain entry, run:

```sh
python3 scripts/test-jev-routing-keychain.py --live
```

This launcher reads service `ai.kordi.dev.jev.vercel-ai-gateway`, account `local-test`, into the test process's `AI_GATEWAY_API_KEY` environment after compilation. It selects `KORDI_JEV_PROVIDER=vercel` and model `typesafe-ai/jev`. The key never enters command-line arguments, source files or test output. Other environments can inject these variables through their secret configuration instead.

The evaluation waits 15 seconds between fixtures by default (`KORDI_JEV_EVAL_INTERVAL_MS`, bounded to 1–60 seconds), so the test does not issue a burst against a limited Gateway account. It stops after the first failed evaluation instead of continuing against a rate-limited provider. This pacing is excluded from decision latency. The evaluation requires credentials, reports decision latency, inferred avoided generation invocations, successful-response token usage and missed material changes, and fails if any material fixture is skipped or an evaluation fails to complete. It covers commitments, cancellations, short replies, multilingual messages, polls, and injected routing instructions. It does not execute tools, call the generative model, or claim end-to-end savings. Independently label additional representative cases before tuning thresholds.

Start in isolated comparison mode, measure routing errors, then compare actual full-run latency, generation/tool calls and total provider cost against the existing deterministic-plus-LLM baseline. Keep the switches off until that comparison supports enabling each consumer. No 30–50% token reduction or cost saving has been established by unit tests.

## Remaining work in #1601

- Calibrate on representative synthetic and explicitly authorized evaluation sets; measure complete-run quality, latency and paid usage.
- Assess whether evidence ranking can reduce input further without missing commitments or corrections. This slice does not prune stored transcripts or omit changed evidence.
- Direct PiP mutation without a generative planner requires a separately validated bounded argument-construction policy. It is not enabled by an action recommendation.

References: [TypeSafe API](https://docs.typesafe.ai/api), [model limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13), [Gateway evaluation](https://vercel.com/docs/ai-gateway/modalities/evaluation), [official Gateway transport source](https://github.com/vercel/ai/blob/main/packages/gateway/src/gateway-evaluation-model.ts), [Awesome Jev](https://awesomejev.com/).

## Initial Vercel smoke test

The initial synthetic smoke test authenticated successfully and completed four evaluations. The unpaced batch then received HTTP 429 responses, and a paced follow-up remained rate-limited and was stopped. This establishes connectivity and response compatibility, not routing accuracy or savings. Both feature flags remain off until a complete evaluation is available. The final launcher paces fixtures and stops at the first provider failure.

## Inspectable metrics and fallback evidence

Each live fixture now prints a structured `evaluation` result: success/failure, validated choices and probability distributions, token usage and applied route. Reports are saved as JSON and Markdown under `.build/jev-evaluations` even if the evaluation fails. Successful evaluation latency is summarized separately from fallback latency. A successful request is not counted as an avoided LLM call unless the applied route is `Skip`; reported generation counts remain inferred because this command does not execute the generative LLM.

The initial smoke output did not retain per-request usage or raw Jev choices. Recovered metrics label those fields unavailable and preserve only observed timings, applied routes and aggregate usage. New reports capture the missing fields directly.

`failed_jev_preserves_pip_generation_plan_card_execution_and_reply` exercises the complete PiP runner with simulated HTTP 429/503, malformed evaluation, network failure, expired deadline, missing evaluator credentials and an open circuit. Every scenario must invoke the original planner, forward its plan-card action through the normal run-bound client, and return its final reply. It uses a fake generation provider and server; it verifies fallback orchestration, not live model quality or production availability.

The latest inspectable live result is [the synthetic routing report](evaluations/jev-routing-smoke.md), with [structured results](evaluations/jev-routing-smoke.json). It includes five validated responses, one HTTP 429 fallback and six unattempted fixtures. The [PiP fallback regression report](evaluations/pip-jev-fallback.md) records the separate simulated failure checks.

## Paired savings benchmark

The [completed paired synthetic comparison](evaluations/synthetic-savings/analysis-report.md) uses the development server's PiP credential in place through a task-owned SSH helper. Twelve cases run both the baseline and Jev consumer loops with live generation and simulated tools. The same 16 generation calls occurred in each arm; standardized known-usage cost increased 3.36% with Jev. Cache-adjusted estimates and their cache carryover limitation are recorded separately. Both paths passed all twelve fixture checks, including Jev rate-limit fallbacks. This does not establish production savings, and the feature flags remain off.

The reusable driver is `scripts/benchmark-jev-savings.py`; `--remote-session` accepts private task-owned helper metadata, which must remain outside the repository. The worker source is `scripts/jev-savings-provider-worker.py`. Infrastructure identifiers and keys are never committed. `scripts/analyze-jev-savings.py` generates the descriptive report and plots from checkpointed synthetic results.

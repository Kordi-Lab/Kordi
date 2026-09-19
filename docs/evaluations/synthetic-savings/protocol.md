# Synthetic savings comparison protocol

Question: what is the observed token-priced cost and latency difference between the current PiP/Digest runner and that same runner with Jev routing enabled?

- Twelve new, hand-authored scenarios: six PiP and six Digest, each with two irrelevant and four material changes. These are eligible runner snapshots, not a sample of all incoming messages. PiP irrelevant cases contain plan keywords that can pass its existing text prefilter.
- Unit: one independent synthetic conversation scenario. Each scenario runs both arms with fresh simulated tool state. Scenario order and the six baseline-first/six Jev-first assignments are shuffled with seed 1601 and persisted before requests.
- Baseline: actual runner, routing off. Treatment: actual runner, current default routing thresholds, including its real fallback and circuit breaker behavior. No production flags or thresholds change.
- Generation: Vercel `openai/gpt-5.6-luna`, matching PiP's source-code default family. Digest uses this same model for comparison; account-specific production choices are not known. Both arms use temperature 0, reasoning effort none, a 2,048 completion-token cap, and non-streaming requests to collect usage. These explicit benchmark settings differ from unspecified production defaults.
- Prompts and tool definitions come from the repository. PiP tool effects use an in-memory card simulator; Digest reads frozen synthetic sources through its real read-only tools. No real chats, tasks or calendars are changed.
- Capture every arm's actual model calls, reported input/output/cache tokens, latency, output and simulated tool actions. Capture Jev successes and failures, including rate limits. Treat outages as treatment outcomes, not exclusions. Pause 15 seconds between scenarios; do not loop-retry a rate-limited evaluation outside the existing bounded adapter.
- Cost: price observed usage using a snapshot of Vercel's public model catalog. Report uncached standardized costs and cache-adjusted estimates separately. They are estimates, not billing exports; unknown usage from failed requests is not invented. Include Jev's catalog price even if a temporary promotion waives it.
- Quality: irrelevant cases must not create new Digest items or mutate PiP cards; material cases must preserve the expected cited item/action. Report exact quality failures beside savings. Simulated tools are not a substitute for production authorization testing.
- One paired observation per case: descriptive estimates only, no population significance or general reliability claim. The one-third irrelevant scenario mix is artificial. Report separate PiP/Digest totals and scale dollars per 1,000 comparable eligible jobs only.
- Optional sensitivity: replay the recorded routing probabilities at a predeclared 0.99 skip threshold. This is a counterfactual cost estimate using measured baseline costs, not a deployed policy or another independent experiment.
- Hard bound: 64 generation requests, max 8 per runner invocation, no real mutation tools. Preserve incomplete arms and errors. Stop conclusions at the evidence available.

Design reference: Kassis, T., Agarwal, V., He, Y., Patel, D., and Brueckner, A. M. (2026). Scientific Agent Skills: A Library of Procedural Knowledge for Research Agents. https://doi.org/10.48550/arXiv.2609.00065 (current arXiv v2 inspected September 19, 2026).

## First attempt status

The first baseline generation request through the saved Vercel key returned HTTP 403. No valid paired observations or generation token usage were obtained. This is an access blocker, not evidence of zero model cost or a quality failure. The configured local PiP credential was not present in the test process or the known local development environment files. The benchmark can use `KORDI_PIP_OPENAI_API_KEY` and `KORDI_PIP_OPENAI_MODEL` when supplied through an authorized local test configuration. Production credentials must not be copied into this test environment.

## Completed development-key run

The access blocker was resolved by a task-owned SSH stdio worker on the approved isolated development host. It loaded the configured PiP credential inside that host and called the provider there. Only synthetic responses and numeric usage crossed back to the benchmark. The credential was not copied. All 24 arms completed; task-owned remote and local helper files were removed afterward. No service was restarted or reconfigured. The actual model was `gpt-5.6-luna`; benchmark latency includes the SSH relay.

[Analysis](analysis-report.md), [metrics](metrics.json), [raw synthetic evidence](raw-results.json), [statistics limitations](stats-appendix.md), and [figure catalog](figure-catalog.md) document the completed run. In particular, cache-adjusted estimates are shown separately from the primary standardized comparison; repeated prompts warm the shared provider cache and must not be presented as Jev-specific savings.

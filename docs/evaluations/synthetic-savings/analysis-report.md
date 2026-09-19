# Synthetic PiP and Digest savings comparison

Twelve hand-authored scenarios; one paired measurement per case. One-third of cases are irrelevant. Both arms run actual consumer loops and live generation through the development server; tools are simulated. No production data or calendar changes were used.

Prices are standardized estimates from reported token usage and the snapshotted catalog, not invoice totals. Failed evaluation requests without returned usage may have unreported cost. Negative savings means additional cost.

| Workload | Cases | Baseline calls | Jev calls | Baseline USD | Jev USD | Saving | Quality baseline / Jev |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| pip | 6 | 10 | 10 | 0.005750 | 0.005904 | -2.69% | 6/6 / 6/6 |
| digest | 6 | 6 | 6 | 0.002627 | 0.002754 | -4.84% | 6/6 / 6/6 |
| combined | 12 | 16 | 16 | 0.008377 | 0.008659 | -3.36% | 12/12 / 12/12 |

Jev: 5 successful responses, 5 failed evaluations. Circuit bypasses are not API successes.

## Per-case measurements

| Case | Baseline ms | Jev ms | Baseline model calls | Jev model calls | Quality baseline / Jev |
| --- | ---: | ---: | ---: | ---: | --- |
| digest-commitment | 2228 | 2630 | 1 | 1 | True / True |
| digest-acceptance | 1516 | 1911 | 1 | 1 | True / True |
| pip-weather | 1193 | 1377 | 1 | 1 | True / True |
| pip-vote | 2221 | 2956 | 2 | 2 | True / True |
| pip-decline | 2614 | 3175 | 2 | 2 | True / True |
| digest-cancel | 1692 | 2737 | 1 | 1 | True / True |
| pip-nostalgia | 948 | 2117 | 1 | 1 | True / True |
| pip-proposal | 2573 | 4150 | 2 | 2 | True / True |
| digest-decision | 1728 | 1866 | 1 | 1 | True / True |
| pip-cancel | 2609 | 3318 | 2 | 2 | True / True |
| digest-joke | 980 | 842 | 1 | 1 | True / True |
| digest-cat | 830 | 1926 | 1 | 1 | True / True |

## Cache-adjusted estimates

| Workload | Baseline USD | Jev USD | Apparent saving |
| --- | ---: | ---: | ---: |
| pip | 0.001592 | 0.001353 | +14.98% |
| digest | 0.001365 | 0.001261 | +7.61% |
| combined | 0.002957 | 0.002615 | +11.58% |

Cache-adjusted costs use the returned cached-token counts and cache-read rate. Their apparent savings cannot be attributed to Jev: both arms made the same number of generation calls, and repeated paired prompts share cache state. The six/six order balance does not eliminate cross-case cache warm-up. The primary table standardizes cache prices to isolate usage and evaluator overhead.


## Counterfactual threshold sensitivity

Replaying the observed scores at 0.99 would skip 0 cases and estimate -3.36% cost savings on this same workload. Material cases skipped: 0. This is a counterfactual, not a deployed policy or independent validation. It is insufficient to establish a safe production threshold.

## Limits

- The fixture distribution is artificial; dollars per 1,000 apply only to comparable eligible jobs, not all messages or an account bill.
- Temperature 0, reasoning none and the output cap were fixed for both arms. Production defaults and account-specific Digest models may differ.
- Prompt caching, generation variability, the SSH relay and local-to-Gateway evaluation routing affect latency and costs. Cache-adjusted estimates are provided separately in metrics.json.
- Quality checks verify selected actions and cited item categories. They are coarse tests, not comprehensive human quality ratings.
- One realization per scenario cannot establish model reliability or population significance. No p-values or population confidence intervals are reported.
- Production feature flags and thresholds were not changed.

## Evidence and references

- raw-results.json: checkpointed synthetic responses, usage and errors.
- metrics.json: paired costs, cache-adjusted estimates and threshold sensitivity.
- https://ai-gateway.vercel.sh/v1/models: price snapshot.
- Kassis, Agarwal, He, Patel and Brueckner (2026), Scientific Agent Skills: https://doi.org/10.48550/arXiv.2609.00065.


## Claim candidates

- Claim: On this fixed suite, current Jev routing increased standardized known-usage cost by the measured percentage.
  - Source evidence: metrics.json and raw-results.json; 12 complete paired scenarios.
  - Allowed wording: observed on these synthetic fixtures at the snapshotted token prices.
  - Forbidden stronger wording: a reliable production billing forecast or a significant population effect.
  - Uncertainty: one realization per case, artificial case mix, provider-rate-limit failures and unreported failed-request usage.
  - Next check: a full healthy-evaluator run on a larger independent synthetic suite with repeated measurements.
  - Decision: keep with scope limitations.

- Claim: PiP and Digest generation continued despite evaluator rate limits or circuit bypasses.
  - Source evidence: each affected treatment arm completed and passed its fixture check.
  - Allowed wording: fallback worked in the observed synthetic run with live generation and simulated tool effects.
  - Forbidden stronger wording: production reliability is guaranteed or server authorization was end-to-end tested.
  - Uncertainty: restricted fixture set and simulated plan-card server.
  - Next check: isolated full-stack failure injection with synthetic accounts.
  - Decision: keep with scope limitations.

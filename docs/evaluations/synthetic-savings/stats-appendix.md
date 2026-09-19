# Descriptive statistics and inference limits

The unit is a scenario, with two repeated conditions. Seed 1601 fixes scenario order and six baseline-first/six treatment-first assignments. There is one provider realization per cell. Cases were hand-authored, so inferential tests and population confidence intervals would overstate evidence; they are intentionally omitted.

- pip/baseline: n=6, latency mean 2026.3 ms, sample SD 758.8 ms. Dispersion is across scenarios, not repeated-run variability.
- pip/jev: n=6, latency mean 2848.8 ms, sample SD 972.9 ms. Dispersion is across scenarios, not repeated-run variability.
- digest/baseline: n=6, latency mean 1495.7 ms, sample SD 517.4 ms. Dispersion is across scenarios, not repeated-run variability.
- digest/jev: n=6, latency mean 1985.3 ms, sample SD 679.9 ms. Dispersion is across scenarios, not repeated-run variability.

Effect sizes are paired total-cost differences and percent changes in metrics.json. No multiple-comparison significance claims are made.

Allowed claim: the observed cost on these fixtures changed by the recorded amount. Forbidden stronger claim: the same percentage will be saved on production traffic, or no material message will ever be skipped.

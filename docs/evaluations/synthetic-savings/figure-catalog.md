# Figure interpretation

- **cost-comparison**: sums measured usage at catalog prices, scaled per 1,000 comparable jobs; no error bars because the fixtures are fixed, with one realization each. Compare whether evaluator overhead is offset by changed generation usage. This does not establish an account-wide savings rate.
- **paired-latency**: connects baseline and Jev times for each scenario; no error bars or independence claim across conditions. Inspect whether time increases on jobs that still generate. Timing includes the shared SSH relay, so these are benchmark timings rather than production SLA predictions.

Both figures use all complete pairs and distinguish the two conditions by position/marker as well as color.

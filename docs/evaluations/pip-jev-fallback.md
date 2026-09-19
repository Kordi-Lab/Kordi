# PiP fallback regression evidence

These are isolated regression tests with a simulated evaluation provider, generation provider and plan-card server. They verify execution through the PiP runner, not live model quality. Each case keeps the original PiP prompt and tool catalog, invokes the planner, forwards its RSVP call and returns its final reply.

| Jev failure | Planner calls | Plan-card calls | Reply |
| --- | ---: | ---: | --- |
| rate_limit | 2 | 1 | completed |
| upstream_failure | 2 | 1 | completed |
| invalid_reply | 2 | 1 | completed |
| network_failure | 2 | 1 | completed |
| deadline | 2 | 1 | completed |
| missing_key | 2 | 1 | completed |
| open_circuit | 2 | 1 | completed |

Result: 7 of 7 scenarios passed.

Reproduce:

```sh
cargo test -p kordi-cloud-agent-runner --lib failed_jev_preserves_pip_generation_plan_card_execution_and_reply -- --nocapture
```

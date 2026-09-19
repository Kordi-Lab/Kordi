# Jev routing evaluation

Provenance: live synthetic evaluation.

A successful API evaluation means a validated response; it does not establish routing accuracy or cost savings.

| Consumer | Fixture | API result | Decision ms | Input tokens | Output tokens | Jev choice | Selected probability | Applied route |
| --- | --- | --- | ---: | ---: | ---: | --- | ---: | --- |
| Digest | unrelated-chat | succeeded | 1189 | 945 | 77 | skip | 0.99 | Generate |
| Digest | commitment | succeeded | 446 | 955 | 77 | generate | 0.96 | Generate |
| Digest | cancellation | succeeded | 482 | 952 | 77 | generate | 0.98 | Generate |
| Digest | short-acceptance | succeeded | 436 | 958 | 77 | generate | 0.81 | Generate |
| Digest | french-reschedule | succeeded | 665 | 959 | 77 | generate | 0.98 | Generate |
| Digest | injection | failed | 1071 | - | - | - | - | Generate |

## Summary

```json
{
  "baselineGenerationInvocations": 6,
  "complete": false,
  "decisionMedianMs": 665,
  "decisionP95Ms": 1189,
  "evaluationRequests": 6,
  "failedEvaluations": 1,
  "fixtures": 6,
  "inputTokens": 4769,
  "intervalMs": 15000,
  "missedMaterialChanges": 0,
  "model": "typesafe-ai/jev",
  "note": "Routing evaluation only. Generation invocation counts are inferred; no generative LLM or tools were executed. Token totals cover successful evaluation responses only.",
  "outputTokens": 385,
  "plannedFixtures": 12,
  "routedGenerationInvocations": 6,
  "successfulDecisionMedianMs": 482,
  "successfulDecisionP95Ms": 1189,
  "successfulEvaluations": 5,
  "unnecessaryGenerationInvocations": 1
}
```

Five of six attempted evaluations returned validated responses; the sixth returned HTTP 429 and took the generation fallback. Six remaining planned fixtures were not attempted. Successful input/output usage totals were 4,769 / 385 tokens. No generative LLM calls were made by this routing-only harness, and zero generation calls were predicted to be avoided. The unrelated-chat `skip` probability of 0.99 was below the Gateway skip threshold of 0.995, so its applied route remained `Generate`.

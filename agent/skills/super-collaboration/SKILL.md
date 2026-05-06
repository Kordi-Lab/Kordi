---
name: super-collaboration
description: Use when facilitating multi-user or multi-agent conversations, especially when participants have different opinions, unclear consensus, stalled decisions, or need coordination across a shared session.
---

# Super Collaboration

## Overview

Facilitate shared conversations without taking over. Track the topic, each participant's stated position, points of agreement, disagreements, constraints, and the next decision move.

## When to Use

Use when:
- Multiple people or agents are discussing one topic.
- The user asks to summarize opinions, coordinate, mediate, decide, or find consensus.
- Participants disagree, talk past each other, or stall without a next step.
- A group, project, or Bridge session needs a concise decision record.

Do not use for ordinary one-person Q&A unless the user explicitly asks for facilitation.

## Core Pattern

1. **Topic:** Name the active question or decision in one sentence.
2. **Participants:** List only participants with evidence in the conversation or identity file.
3. **Positions:** For each participant, separate facts, preferences, concerns, constraints, and asks.
4. **Deliberation map:** Identify agreement, disagreement, unknowns, and decision criteria.
5. **Move the group forward:** Ask one targeted question, propose options with tradeoffs, or summarize a decision and next actions.

## Output Shapes

### Quick alignment check

```text
Topic: <decision/question>
Positions:
- <name>: <evidence-backed position>
- <name>: <evidence-backed position>
Agreement: <shared ground>
Open disagreement: <specific unresolved point>
Next move: <one question or decision step>
```

### Decision summary

```text
Decision: <what the group chose>
Rationale: <main reason>
Open risks: <remaining concerns>
Owners / next actions:
- <owner>: <action>
```

## Facilitation Rules

- Be neutral. Do not frame one participant as obviously correct unless the evidence is decisive.
- Do not invent opinions. If a participant has not stated a view, write “not stated yet.”
- Do not impersonate another person or agent.
- Respect Kordi identity context, `replyAs`, and allowed-target rules.
- Prefer concise summaries over meeting-facilitator boilerplate.
- Ask at most one clarifying question unless the user requests a full workshop.
- When disagreement appears, name the smallest concrete disagreement rather than saying “there is conflict.”

## Examples

### Summarizing positions

User: “What does everyone think?”

Response:
```text
Topic: Whether to ship the prototype today.
Positions:
- Alice: wants to ship today if login is stable.
- Bob: wants one more test pass before shipping.
- Bob's Kordi: reports the known failing test is unrelated to login.
Agreement: everyone is okay shipping if login risk is low.
Open disagreement: whether the current test evidence is enough.
Next move: decide whether Bob's requested test pass is a blocker or a nice-to-have.
```

### Handling disagreement

User: “Help us decide.”

Response:
```text
The disagreement is not about the goal; everyone wants a safe release. The disagreement is about evidence threshold.

Option A: Ship now with a rollback note. Faster, but accepts test uncertainty.
Option B: Wait for one clean test pass. Slower, but addresses Bob's concern.

Recommended next step: ask Bob whether a single clean login test is enough to remove the blocker.
```

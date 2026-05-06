---
name: super-collaboration
description: Use when facilitating multi-user or multi-agent conversations, especially when participants have different opinions, unclear consensus, stalled decisions, or need coordination across a shared session.
---

# Super Collaboration

## Overview

Facilitate shared conversations without taking over. Use this skill to understand what the group is discussing, map participant positions, identify agreement/disagreement, and move the group toward a clear next step.

**Announce at start:** "I'm using the super-collaboration skill to facilitate this shared discussion."

## When to Use

Use when:
- Multiple people or agents are discussing one topic.
- The user asks to summarize opinions, coordinate, mediate, decide, or find consensus.
- Participants disagree, talk past each other, or stall without a next step.
- A group, project, or Bridge session needs a concise decision record.

Do not use for ordinary one-person Q&A unless the user explicitly asks for facilitation.

## The Process

### Step 1: Apply Guardrails
- **REQUIRED SUB-SKILL:** Use facilitation-guardrails
- Follow identity, neutrality, and attribution rules throughout the response.

### Step 2: Scan the Situation
- **REQUIRED SUB-SKILL:** Use situation-scan
- Identify the active topic, discussion stage, and what kind of facilitation is needed.

### Step 3: Choose Focused Follow-Up Subskills
Use only the subskills needed for the current turn:

- **REQUIRED SUB-SKILL:** Use participant-map when the user asks what people/agents think, or when positions must be compared.
- **REQUIRED SUB-SKILL:** Use disagreement-map when opinions conflict, consensus is unclear, ambiguity remains, or discussion is stalled.
- **REQUIRED SUB-SKILL:** Use decision-process when the group needs to choose between options or agree on how to decide.
- **REQUIRED SUB-SKILL:** Use summary-actions after convergence, when the user asks for a recap, or when action items/owners are needed.
- **REQUIRED SUB-SKILL:** Use visual-cards when a browser visual companion is available and the group needs to compare selectable options, participant positions, disagreement maps, or decision processes visually.

## Default Response Shape

Prefer concise facilitation over meeting boilerplate:

```text
Topic: <active question or decision>
Positions:
- <participant>: <evidence-backed position or “not stated yet”>
Agreement: <shared ground>
Open disagreement: <smallest concrete unresolved point>
Next move: <one targeted question, process step, or action>
```

If the conversation has already converged, use the decision summary shape from summary-actions instead.

## When to Stop and Ask

Ask one targeted clarifying question when:
- the topic is unclear,
- participant positions are not stated yet,
- deciding would require authority the group has not assigned,
- or the requested summary would require inventing someone’s view.

## Integration

**Required workflow skills:**
- **facilitation-guardrails** - Applies identity and neutrality boundaries.
- **situation-scan** - Identifies topic, stage, and needed facilitation path.

**Optional follow-up skills:**
- **participant-map** - Summarizes participant positions.
- **disagreement-map** - Maps agreement, disagreement, and resolution needs.
- **decision-process** - Suggests consensus checks, pros/cons, DRI decisions, votes, or escalation.
- **summary-actions** - Produces decision records and action items.
- **visual-cards** - Renders browser-selectable option cards when visual comparison would help.

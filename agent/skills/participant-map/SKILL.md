---
name: participant-map
description: Subskill for super-collaboration. Use when summarizing what each person or agent thinks in a shared discussion.
---

# Super Collaboration Participant Map

## Overview

Track participants and their evidence-backed positions without inventing missing opinions.

## The Process

### Step 1: Identify Participants
List only participants with evidence in the conversation or identity file.

### Step 2: Separate Position Types
For each participant, separate:

- **Facts:** Claims or evidence they introduced.
- **Preferences:** What they want or favor.
- **Constraints:** Requirements, deadlines, permissions, resource limits, or technical limits.
- **Concerns:** Risks, objections, or uncertainty.
- **Asks:** Questions, requests, or decisions they want from others.

### Step 3: Mark Missing Positions
If a known participant has not stated a position on the topic, write “not stated yet.”

### Step 4: Preserve Speaker Attribution
Do not merge a human's view with their agent's view unless the conversation explicitly says they are aligned.

## Output Shape

```text
Positions:
- <participant>: <facts/preferences/concerns/constraints relevant to the topic>
- <participant>: <facts/preferences/concerns/constraints relevant to the topic>
```

If helpful, add:

```text
Still missing: <whose view or constraint is not stated yet>
```

---
name: situation-scan
description: Subskill for super-collaboration. Use when identifying the active topic, discussion stage, and needed facilitation path in a shared session.
---

# Super Collaboration Situation Scan

## Overview

Identify what the group is currently trying to resolve before summarizing positions or recommending a process.

## The Process

### Step 1: Name the Topic
State the active question, decision, or coordination problem in one sentence.

### Step 2: Classify the Stage
Choose one:
- exploring options
- comparing tradeoffs
- resolving disagreement
- deciding
- executing agreed actions

### Step 3: Check Evidence
Use only current conversation context and any identity/session files the stable Kordi prompt says to read.

### Step 4: Pick the Needed Facilitation Path
Choose the next subskill need:
- participant map
- disagreement map
- decision process
- summary/actions

## Output Shape

If the user asks a broad prompt like “what do people think?” or “help us decide,” start with:

```text
Topic: <active question or decision>
Current stage: <stage>
Needed facilitation: <participant map | disagreement map | decision process | summary/actions>
```

Then continue with the needed subskill output.

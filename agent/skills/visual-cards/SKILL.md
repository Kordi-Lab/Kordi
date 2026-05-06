---
name: visual-cards
description: Subskill for super-collaboration. Use when a browser visual companion is available and selectable cards, maps, or diagrams would help a group compare options or decide.
---

# Visual Cards

## Overview

Render browser-selectable cards for collaboration choices when visual comparison is clearer than text alone.

Use this only when a browser visual companion or equivalent HTML preview surface is available. If not available, provide the same options as concise text.

## When to Use

Use visual cards for:
- comparing decision options,
- choosing a decision process,
- mapping participant positions side by side,
- showing agreement versus disagreement,
- selecting next actions or owners.

Do not use browser cards for ordinary clarifying questions or purely textual requirements.

## The Process

### Step 1: Decide Whether Visual Helps
Ask: would the group understand this better by seeing it than reading it?

If yes and browser support exists, render cards. If no, stay in text.

### Step 2: Create Selectable Cards
Each card should include:
- a short label,
- the option or position,
- key tradeoffs,
- when to choose it.

### Step 3: Use Browser Selection Markup
When writing HTML fragments for a visual companion, use selectable cards with `data-choice`:

```html
<h2>Which decision process fits?</h2>
<p class="subtitle">Pick the process that matches how much agreement the group has.</p>

<div class="cards">
  <div class="card" data-choice="consensus-check" onclick="toggleSelect(this)">
    <div class="card-body">
      <h3>Consensus check</h3>
      <p>Use when disagreement seems small and the group needs a quick alignment check.</p>
    </div>
  </div>
  <div class="card" data-choice="dri-decision" onclick="toggleSelect(this)">
    <div class="card-body">
      <h3>DRI decision</h3>
      <p>Use when speed matters or one person owns the outcome.</p>
    </div>
  </div>
</div>
```

### Step 4: Ask for Review
After rendering, tell the user what is on screen and ask them to select or comment.

## Output Guidance

If using browser cards:

```text
I rendered selectable cards for the decision options. Please pick the card that best matches the group’s preferred path, or tell me what to change.
```

If browser support is unavailable:

```text
I can’t render selectable browser cards here, so I’ll show the options in text:
- <option>: <tradeoff>
- <option>: <tradeoff>
```

## Integration

**Called by:**
- **super-collaboration** - when visual comparison would help shared facilitation.
- **decision-process** - when choosing between process options.
- **disagreement-map** - when visualizing agreement versus unresolved disagreement.
- **participant-map** - when comparing participant positions side by side.

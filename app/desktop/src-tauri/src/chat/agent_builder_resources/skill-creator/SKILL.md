---
name: skill-creator
description: Design and maintain focused Kordi skills with complete SKILL.md instructions.
---

# Skill creator

Create a skill only when reusable procedural guidance is necessary for the candidate agent.

Each skill lives at `skills/<skill-name>/SKILL.md` and must contain valid YAML frontmatter:

```yaml
---
name: skill-name
description: A precise description of when this skill should be used.
---
```

Follow the frontmatter with clear operational instructions. Keep a skill narrow, remove duplicated general advice, and state required inputs, workflow, constraints, validation, and expected outputs. Use lowercase kebab-case names. The directory name, frontmatter name, and `agent.json` reference must agree.

Before finishing, reread every changed skill and verify that it contains no secrets, private paths, unexplained placeholders, or permissions broader than the agent needs.

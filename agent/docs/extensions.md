# Extensions & Skills

Kordi supports two extension mechanisms: **skills** (markdown instructions) and **extensions** (JS/TS plugins).

Kordi now prefers `.kordi` paths for project/global extension resources. Legacy agent paths are still discovered and are migrated when the new target does not already exist.

## Role in Kordi

Use this document when you need the extension surface for the Kordi agent layer.

It is the reference for:

- skills
- plugin extensions
- prompt templates
- discovery and install locations

## Skills

Skills are markdown files that provide contextual instructions to the agent. They're listed in the system prompt and the agent reads them when relevant.

### Creating a Skill

Create a directory with a `SKILL.md` file:

```
~/.kordi/skills/my-skill/SKILL.md
```

Use YAML frontmatter for metadata:

```markdown
---
name: my-skill
description: Helps with deploying to production
---

## Deployment Instructions

When the user asks about deployment:

1. Check the environment with `bash: env | grep DEPLOY`
2. Run the deploy script: `bash: ./deploy.sh`
3. Verify with: `bash: curl -s https://api.example.com/health`
```

### Skill Discovery Paths

Skills are auto-discovered from:

| Location | Scope |
|----------|-------|
| `~/.kordi/skills/` | Global |
| `<project>/.kordi/skills/` | Project-local |
| `~/.agents/skills/` | Shared (pi-compatible) |
| `<ancestors>/.agents/skills/` | Ancestor directories |
| `settings.json` → `"skills": [...]` | Explicit paths |

### Skill Packages

Install skills from npm or git:

```bash
kordi install npm:some-skill-package     # Global install
kordi install --local npm:my-skill       # Project-local install
kordi install git:https://github.com/org/skills.git
```

A skill package is an npm package with a `kordi` field in `package.json`:

```json
{
  "name": "my-skill-package",
  "kordi": {
    "skills": ["skills/"],
    "extensions": ["extensions/"],
    "prompts": ["prompts/"]
  }
}
```

Or simply place resources in `skills/`, `extensions/`, `prompts/` directories.

## Extensions (JS/TS Plugins)

Extensions are JavaScript or TypeScript files that can register custom tools, commands, and event hooks.

### Loading Extensions

| Location | Scope |
|----------|-------|
| `~/.kordi/extensions/` | Global |
| `<project>/.kordi/extensions/` | Project-local |
| `settings.json` → `"extensions": [...]` | Explicit paths |
| CLI: `kordi -e ./my-extension.ts` | Ad-hoc |

### Extension API

Extensions communicate with Kordi via stdin/stdout JSON protocol. They can:

- **Register tools** — custom tools the agent can call
- **Register commands** — slash commands (e.g., `/mycommand`)
- **Hook events** — intercept session start, input, tool calls, etc.

### Example Extension Structure

```
my-extension/
├── package.json
├── index.ts          # Entry point
└── tsconfig.json
```

## Prompt Templates

Reusable prompts invoked with `/name` in the input.

### Creating Prompts

Place `.md` files in the prompts directory:

```
~/.kordi/prompts/review.md
```

```markdown
Review the code in the current directory for:
- Security vulnerabilities
- Performance issues
- Code style problems
Provide a structured report.
```

Then use in Kordi:
```
/review
```

### Prompt Discovery Paths

| Location | Scope |
|----------|-------|
| `~/.kordi/prompts/` | Global |
| `<project>/.kordi/prompts/` | Project-local |
| `settings.json` → `"prompts": [...]` | Explicit paths |

## Package Management

```bash
kordi install <source>           # Install globally
kordi install --local <source>   # Install into project
kordi remove <source>            # Remove a package
kordi list                       # List all packages
kordi list --local               # List project packages
kordi list --global              # List global packages
kordi update                     # Update all packages
```

### Package Sources

| Format | Example |
|--------|---------|
| npm | `npm:package-name` |
| git | `git:https://github.com/org/repo.git` |
| local path | `./my-local-skill` or `/absolute/path` |
| URL | `https://example.com/package.tar.gz` |

### Package Filtering

In `settings.json`, you can filter which resources a package provides:

```json
{
  "packages": [
    {
      "source": "npm:big-package",
      "skills": ["skills/only-this-one/**"],
      "extensions": [],
      "prompts": ["*"]
    }
  ]
}
```

## Related docs

- [README.md](README.md)
- [development.md](development.md)
- [configuration.md](configuration.md)

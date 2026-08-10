# Kordi community contributor guide

Kordi is in active beta development. Community contributions are welcome across the desktop experience, collaboration backend, agent runtime, testing, documentation, and design.

You do not need access to Kordi's production infrastructure to contribute. The supported contributor workflow runs the backend and test data on your own machine.

## Start here

1. Read the project overview in the [README](../README.md).
2. Search the [open issues](https://github.com/Kordi-AI/Kordi/issues) for related work or an existing bug report.
3. Comment on the issue before starting a large change so scope and expected behavior are clear.
4. Follow the [isolated local development guide](self-hosted-debug.md) to run Kordi without production access.
5. Open a focused pull request and link it to the issue.

Small, complete improvements are easier to review and merge than broad rewrites. A first contribution can be a documentation correction, regression test, focused bug fix, accessibility improvement, or a clearer error message.

## Choose a contribution area

| Area | Typical work | Start in |
| --- | --- | --- |
| Desktop experience | Chats, groups, settings, onboarding, accessibility, performance, and visual polish | `app/desktop/` |
| Accounts and synchronization | Authentication, contacts, messages, unread state, presence, and attachments | `bridges/cloud-server/` |
| Agent experience | Provider integration, model behavior, tools, sessions, and execution | `agent/` and `bridges/` |
| Shared contracts | Types and behavior used across desktop and backend boundaries | `shared/` |
| Documentation and tests | Guides, regression coverage, fixtures, and contributor workflows | `docs/`, `scripts/`, and component test directories |

If a change crosses several areas, describe the boundaries in the issue before implementation. Maintainers may recommend splitting it into smaller pull requests.

## Run a safe local workspace

Install the required tools and dependencies, then start the isolated backend:

```bash
pnpm install --frozen-lockfile
pnpm debug:cloud:up
pnpm debug:cloud:smoke
```

Launch the native desktop against the loopback API:

```bash
VITE_KORDI_CLOUD_API_BASE=http://127.0.0.1:17081 pnpm dev
```

Development launches reject a missing, invalid, or production API origin. Do not remove or bypass this guard to make a test pass.

For two independent desktop profiles:

```bash
VITE_KORDI_CLOUD_API_BASE=http://127.0.0.1:17081 \
pnpm dev:cloud:multi -- --reset --users user1,user2
```

Use dummy accounts and developer-owned provider credentials. Do not reuse production service identities or credentials supplied by another person.

The complete setup, architecture, logs, proxy troubleshooting, and cleanup instructions are in [Local development with an isolated Kordi backend](self-hosted-debug.md).

## Work from an issue

Before changing code:

- Search for duplicate issues and pull requests.
- Reproduce the behavior on the latest `main` branch when possible.
- Record the smallest reliable reproduction.
- Separate confirmed facts from guesses about the cause.
- Agree on the user-facing behavior for changes that affect workflows or data.

When proposing a feature, explain:

- Who needs it
- What problem they face today
- What the smallest useful outcome is
- Which existing behavior must remain unchanged
- How the result can be tested

Do not include tokens, credentials, private infrastructure details, or unredacted user data in an issue.

## Create a focused branch

Start from the latest `main`:

```bash
git checkout main
git pull origin main
git checkout -b feat/issue-123-short-description
```

Use `fix/` for focused bug fixes, `feat/` for product behavior, and `docs/` for documentation-only changes. Include the issue number when one exists.

Keep unrelated formatting, generated files, local profiles, credentials, and personal configuration out of the branch.

## Test the change

Match validation to the area you changed:

| Change | Minimum useful validation |
| --- | --- |
| Documentation or scripts | Focused script tests and `git diff --check` |
| Desktop UI or state | Relevant unit tests, typecheck, lint, and native manual testing |
| Backend route or synchronization | Relevant Rust tests plus a live local backend scenario |
| Database migration | Upgrade an existing local volume and start from a fresh reset |
| Cross-cutting behavior | `pnpm check:ci` plus a documented end-to-end scenario |

Common commands:

```bash
pnpm check:frontend
pnpm check:rust:test
pnpm check:hygiene
pnpm check:ci
```

For UI work, check light and dark themes, window resizing, long content, empty states, loading states, and failure states when relevant.

For synchronization work, use at least two isolated desktop profiles and verify both the immediate result and the state after relaunch.

## Report a useful bug

A strong bug report lets another contributor reproduce the problem without access to your machine or account.

Use this structure:

```text
Kordi version or commit:

macOS version and device architecture:

Environment:
Local isolated backend / approved staging

What I was doing:

Steps to reproduce:
1.
2.
3.

Expected result:

Actual result:

How often it happens:

Relevant redacted logs:
```

Before attaching screenshots or logs, remove:

- Account and provider tokens
- Passwords and API keys
- Private messages or attachments not created for testing
- Private hostnames, project identifiers, and database details
- Local credential files and provider session files
- Personal filesystem paths when they are not needed for reproduction

## Open a pull request

Open a draft pull request early when the implementation needs feedback. A reviewable PR should include:

- A concise title describing the outcome
- `Closes #123` or `Refs #123`
- What changed and why
- User or developer impact
- Root cause for a bug fix
- Exact automated and manual validation results
- Screenshots or a short video for visible UI changes
- Known limitations or follow-up work

Keep the pull request focused on one outcome. If review reveals an unrelated bug, open a separate issue rather than silently expanding the branch.

## During review

- Respond to technical feedback with evidence, tests, or a concrete explanation.
- Push follow-up commits while review is active so changes remain auditable.
- Resolve conversations only after the requested change or decision is addressed.
- Re-run affected checks after rebasing or resolving conflicts.
- Do not merge around failing checks or unresolved data-safety concerns.

Maintainers may ask for a smaller scope, additional tests, clearer copy, or a manual reproduction. This is part of keeping `main` stable while the product is in beta.

## Production access and privacy

Normal community contributions do not require production SSH, Kubernetes, database, object-store, signing, release, or secret-manager permissions.

The local backend is intentionally inspectable by the developer who runs it. Production access is a separate server-side responsibility enforced through authenticated APIs, IAM, network policy, audit logs, and restricted credentials.

If a maintainer asks for shared-environment validation, use only the approved non-production origin and test identity provided for that work. Never copy production secrets or data into a local or staging environment.

The core-maintainer operator launcher is GitHub-allowlisted and is not part of the community workflow. Do not modify its allowlist or endpoint safeguards to make a contributor test pass.

The isolated contributor backend cannot substitute for product-server validation. If approved core-maintainer work will affect or restart the product server, the operator must follow the [required environment preflight](hosted-cloud-developer-guide.md#required-preflight-before-preview-or-debug), work on the corresponding product-server machine, and run the first end-to-end test through `https://coordinar.io`, never `https://kordi.ai`.

## Where to ask for help

- Use the relevant GitHub issue for implementation and reproduction questions.
- Open a new issue when no existing issue describes the problem or proposal.
- Use the pull request conversation for questions about a submitted change.

Keep questions public when they contain no sensitive information so future contributors can benefit from the answer.

## Related guides

- [Contributing workflow](../CONTRIBUTING.md)
- [Local development with an isolated backend](self-hosted-debug.md)
- [Development command map](development.md)
- [Architecture](architecture.md)
- [Run Kordi Desktop](run-cloud-desktop.md)

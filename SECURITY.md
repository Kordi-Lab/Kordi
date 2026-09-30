# Security Policy

Kordi is a collaboration workspace for people and their AI agents. We take the
security of accounts, conversations, and agent behavior seriously, and we
welcome reports from the community. This policy explains how to report a
security issue privately and what you can expect from us.

## Supported versions

Kordi is in beta. Security fixes are made on `main` and shipped in the next
release on the current channel; older beta builds do not receive backports.

| Component | Supported |
| --- | --- |
| Kordi Desktop for macOS | Latest release on the beta update channel |
| Kordi for iPhone | Latest TestFlight or App Store build |
| Hosted service at `kordi.ai` | Current deployment |
| Source code | Latest commit on `main` |
| Older beta, preview, or acceptance-only builds | Not supported |

If you find an issue in an older build, please check whether it still
reproduces on the latest release before reporting it.

## Reporting a security issue

Please report security issues privately through GitHub's private security
advisory form:

**<https://github.com/Kordi-Lab/Kordi/security/advisories/new>**

You can also reach the form from the repository's **Security** tab. The report
stays private between you and the maintainers until we publish an advisory.

Please do not open public issues, discussions, or pull requests for security
problems, and do not share details in community channels. If you cannot use
GitHub private reporting, open a public issue that asks for a private contact
and leave out any details of the problem.

A machine-readable contact is also published at
<https://kordi.ai/.well-known/security.txt> ([RFC 9116](https://www.rfc-editor.org/rfc/rfc9116)).

## What to include

A clear report helps us reproduce and fix the problem quickly:

- The affected component and version: desktop build, iPhone build, the date
  you observed a hosted-service issue, or the commit you tested.
- A description of the issue and its impact: what someone could read, change,
  or do that they should not be able to.
- Step-by-step reproduction instructions, using only accounts, devices, and
  data you control.
- For agent and prompt-injection issues, the content that triggered the
  behavior, how it reached the agent (message, file, web page, or tool
  result), the agent's configuration, and what the agent did as a result.
- For privacy-claim issues, the published statement or in-app description and
  the observed behavior that contradicts it.
- Logs, screenshots, or recordings, with personal data and credentials removed.
- Whether and how you would like to be credited.

## What to expect

- We aim to acknowledge new reports within a few business days.
- We aim to confirm whether we can reproduce the issue and share our initial
  assessment after we have investigated it.
- We will keep you informed through the private advisory while we work on a
  fix, and we aim to agree on a disclosure date with you before anything is
  published.
- With your permission, we will credit you in the published advisory.

Kordi does not currently offer a paid bug bounty.

## Scope

In scope:

- **Kordi Desktop for macOS** (`app/desktop`), including native commands,
  local storage of credentials and messages, deep links, and the updater.
- **Kordi for iPhone** (`app/ios`), including local storage, notifications,
  and deep links.
- **Cloud server and hosted API** (`bridges/cloud-server`, served at
  `kordi.ai`), including sign-in, OAuth, sessions, devices, contacts,
  conversations, groups, invitations, attachments, calls, realtime sync, and
  notifications.
- **Agent runtime and hosted agent runner** (`agent`,
  `bridges/cloud-agent-runner`), including sandbox isolation, tool
  permissions, provider credential handling, and scheduled tasks.
- **Prompt injection**: content from other people, web pages, files, or tools
  that causes an agent to act, or to reveal data, beyond what the person who
  invoked it authorized, or across conversation, account, or sandbox
  boundaries.
- **Privacy claims**: behavior that contradicts Kordi's published privacy
  statements or in-app descriptions of who can see content, what is sent to
  model providers, how long data is kept, or what deletion removes.
- **Release integrity**: update signing, updater metadata, and published
  release artifacts.
- Credentials or secrets exposed in this repository or in published builds.

Out of scope:

- Social engineering or phishing of Kordi maintainers, users, or service
  providers, and issues that require physical access to an unlocked device.
- Denial-of-service or volume testing, including high-rate automated requests,
  load testing, spam, or resource exhaustion against the hosted service.
- Testing against other people's accounts, conversations, agents, or data.
  Use only accounts you created or have explicit permission to test.
- Reports from automated scanners without a demonstrated impact.
- Issues in third-party services or model providers themselves; please report
  those to the provider. Issues in how Kordi integrates with them are in scope.
- Model output that is inaccurate or objectionable without crossing a security
  or privacy boundary; please open a regular issue for those.

## Testing guidelines

- Create your own test accounts, and use your own devices and model provider
  keys.
- Prefer the isolated local backend described in
  [Local development](docs/self-hosted-debug.md). It runs the full product
  stack on your machine and does not require access to the hosted service.
- When testing the hosted service, keep request volume low and do not degrade
  the service for others.
- Access only the minimum data needed to demonstrate an issue. If you reach
  data that belongs to someone else, stop, do not keep or share it, and
  include that in your report.
- Do not use agents or sandboxes to reach systems you do not own or have
  permission to test.

## Safe harbor

We consider security research that is conducted in good faith and follows
this policy to be authorized. We will not pursue or support legal action
against you for that research, and we will work with you to understand and
resolve the issue. Good faith means that you:

- follow the scope and testing guidelines above;
- avoid privacy violations, destruction or modification of data, and
  interruption or degradation of the service;
- report the issue to us privately and promptly; and
- give us reasonable time to address it before any public disclosure.

If you are unsure whether an activity is covered by this policy, ask through a
private report before you proceed. This policy does not authorize testing of
third-party systems, and it cannot grant permission on behalf of third
parties.

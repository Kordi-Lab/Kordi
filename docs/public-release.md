# Public repository release

Do not make the private development repository public in place. Its historical
commits can retain deleted names, email addresses, local filesystem paths, and
other operator-only metadata.

Use a new public repository and publish an exported snapshot with no private
Git objects, refs, remotes, reflogs, or parent commits:

```bash
git fetch origin main
release_dir="$(mktemp -d)"
git archive --format=tar origin/main | tar -x -C "$release_dir"
cd "$release_dir"
git init -b main
git config user.name "Kordi Contributors"
git config user.email "contributors@kordi.ai"
pnpm install --frozen-lockfile
pnpm test:scripts
git add --all
git commit -m "chore: publish sanitized Kordi source"
git remote add origin <new-public-repository-url>
git push -u origin main
```

Before pushing, verify:

- `pnpm test:scripts` passes, including the privacy guard's own regression tests.
- `pnpm privacy:check` passes. This scans tracked and untracked non-ignored
  files without printing their contents.
- `git rev-list --count HEAD` prints `1`.
- `git remote -v` names only the new public repository before pushing.
- no private remote, local operator allowlist, `.env`, transcript export,
  database, or credential file is staged.
- the public repository is a new repository, not a visibility change to the
  private development repository.

Keep ongoing product work private and export reviewed snapshots to the public
repository. Never merge the private repository's historical commits into the
public repository.

Pull requests and pushes run the same privacy guard in CI. The CI comparison
scan inspects every new commit, so adding a transcript or user screenshot and
deleting it in a later commit still fails.

The guard also rejects hosting details by shape: public IPv4 and IPv6
addresses outside reserved, documentation, and well-known resolver ranges, DNS
names that embed a public address, cloud reverse-DNS names, Google Cloud
project, zone, instance, internal host, and service-account identifiers, and
Linux or macOS home paths. Use documentation addresses such as `203.0.113.7`
and placeholders such as `<PROJECT>` or `example-project` in examples.

Exact private identifiers (instance and host names, project ids, legacy
domains, former addresses, login names, private repository names) are listed
only as SHA-256 hashes in `scripts/lib/private-identifier-hashes.json`. The
guard lowercases text, splits it into dotted tokens, and compares the hash of
every run of whole labels, so a listed value is blocked without being
published. To add one, run `pnpm privacy:add-identifier`, type the value
(one per line, then Ctrl-D), commit the updated list, and run
`pnpm privacy:check`. Enter the exact label sequence that must never appear.
Never add short numbers or current addresses there: a hash of a value with
few possibilities can be reversed by trying every candidate. Put those, and
any term that must stay unguessable, in the `KORDI_PRIVACY_DENYLIST` Actions
secret instead, one term per line; do not commit that denylist. CI passes the
secret to the hygiene job; forks do not receive it and still run every
committed rule.

A weekly workflow, `Privacy scan of GitHub text`, applies the same rules to
issue and pull request text, comments, and release notes. It only reads and
reports locations and rule identifiers, never the matched text; edit the
reported items to clear it.

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
deleting it in a later commit still fails. Store organization-specific private
identity and infrastructure terms in the `KORDI_PRIVACY_DENYLIST` Actions
secret, one term per line; do not commit that denylist to the repository.

import { readFile } from 'node:fs/promises';

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)(?:-preview\.(0|[1-9]\d*))?$/;
const MAX_RELEASE_NOTES_LENGTH = 16_384;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validatePublishedReleaseNotes(value, label) {
  const notes = typeof value === 'string' ? value.trim() : '';
  if (!notes || !/^### (?:Added|Changed|Fixed)$/m.test(notes) || !/^- /m.test(notes)) {
    throw new Error(`${label} does not contain classified release notes`);
  }
  if (notes.length > MAX_RELEASE_NOTES_LENGTH) {
    throw new Error(`${label} exceeds ${MAX_RELEASE_NOTES_LENGTH} characters`);
  }
  return notes;
}

export function releaseNotesFromChangelog(changelog, version) {
  if (typeof changelog !== 'string') throw new Error('CHANGELOG.md contents are required');
  if (!VERSION_PATTERN.test(version)) throw new Error('Release version must be a beta semantic version');
  const match = changelog.match(new RegExp(
    `^## \\[${escapeRegExp(version)}\\] - \\d{4}-\\d{2}-\\d{2}\\n([\\s\\S]*?)(?=^## \\[|(?![\\s\\S]))`,
    'm',
  ));
  if (!match?.[1]) {
    throw new Error(`CHANGELOG.md does not contain classified release notes for ${version}`);
  }
  return validatePublishedReleaseNotes(
    match[1],
    `CHANGELOG.md release notes for ${version}`,
  );
}

export async function releaseNotesForPublication({ version, releaseProfile, releaseNotes }, changelogPath) {
  if (releaseProfile === 'adhoc-preview') {
    return `Kordi ${version} ad-hoc external-test preview`;
  }
  if (releaseNotes !== undefined) {
    return validatePublishedReleaseNotes(releaseNotes, 'Injected release notes');
  }
  return releaseNotesFromChangelog(await readFile(changelogPath, 'utf8'), version);
}

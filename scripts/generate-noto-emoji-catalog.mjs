import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = 'https://googlefonts.github.io/noto-emoji-animation/data/api.json';
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destinations = [
  path.join(repositoryRoot, 'shared/noto-emoji/catalog.json'),
  path.join(repositoryRoot, 'app/ios/Kordi/Resources/noto-emoji/catalog.json'),
];
const skinTones = new Map([
  ['1f3fb', 'light skin tone'],
  ['1f3fc', 'medium-light skin tone'],
  ['1f3fd', 'medium skin tone'],
  ['1f3fe', 'medium-dark skin tone'],
  ['1f3ff', 'dark skin tone'],
]);

function tagValue(tag) {
  return tag.startsWith(':') && tag.endsWith(':') ? tag.slice(1, -1) : tag;
}

function displayName(icon) {
  const base = tagValue(icon.tags[0]).replaceAll('-', ' ');
  const tones = icon.codepoint.split('_').flatMap((codepoint) => skinTones.get(codepoint) ?? []);
  return `${base.charAt(0).toUpperCase()}${base.slice(1)}${tones.length ? `: ${tones.join(', ')}` : ''}`;
}

function emojiValue(codepoint) {
  return String.fromCodePoint(...codepoint.split('_').map((value) => Number.parseInt(value, 16)));
}

const response = await fetch(source);
if (!response.ok) throw new Error(`Unable to download Noto Emoji metadata: ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
const payload = JSON.parse(bytes.toString('utf8'));
if (!Array.isArray(payload.icons) || payload.icons.length === 0) {
  throw new Error('Noto Emoji metadata did not contain icons.');
}

const emoji = payload.icons.map((icon) => {
  if (!/^[0-9a-f]+(?:_[0-9a-f]+)*$/.test(icon.codepoint) || !icon.tags?.[0]) {
    throw new Error(`Invalid Noto Emoji metadata entry: ${JSON.stringify(icon)}`);
  }
  return {
    id: icon.codepoint,
    value: emojiValue(icon.codepoint),
    name: displayName(icon),
    keywords: [...new Set(icon.tags.map(tagValue))],
    category: icon.categories?.[0] ?? 'Emoji',
  };
});
if (new Set(emoji.map(({ id }) => id)).size !== emoji.length) {
  throw new Error('Noto Emoji metadata contains duplicate codepoints.');
}

const catalog = `${JSON.stringify({
  schema: 1,
  source,
  sourceSha256: createHash('sha256').update(bytes).digest('hex'),
  license: 'CC-BY-4.0',
  emoji,
}, null, 2)}\n`;

for (const destination of destinations) {
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, catalog);
}

console.log(`Wrote ${emoji.length} Noto Emoji entries.`);

#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UNICODE_EMOJI_VERSION = '17.0';
const CLDR_VERSION = '48.2.0';
const UNICODE_SOURCE = `https://www.unicode.org/Public/${UNICODE_EMOJI_VERSION}.0/emoji/emoji-test.txt`;
const CLDR_SOURCE = `https://raw.githubusercontent.com/unicode-org/cldr-json/${CLDR_VERSION}/cldr-json`;

const LOCALES = [
  { id: 'en', source: 'en' },
  { id: 'zh-Hans', source: 'zh' },
  { id: 'ar', source: 'ar' },
  { id: 'es', source: 'es' },
  { id: 'pt', source: 'pt' },
];

const CATEGORY_BY_GROUP = new Map([
  ['Smileys & Emotion', 'smileys'],
  ['People & Body', 'people'],
  ['Animals & Nature', 'animals'],
  ['Food & Drink', 'food'],
  ['Travel & Places', 'travel'],
  ['Activities', 'activities'],
  ['Objects', 'objects'],
  ['Symbols', 'symbols'],
  ['Flags', 'flags'],
]);

const SKIN_TONE_BY_CODEPOINT = new Map([
  [0x1f3fb, 'light'],
  [0x1f3fc, 'mediumLight'],
  [0x1f3fd, 'medium'],
  [0x1f3fe, 'mediumDark'],
  [0x1f3ff, 'dark'],
]);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPaths = [
  path.join(repoRoot, 'app/desktop/src/features/emoji/generated/emoji-catalog-v17.json'),
  path.join(repoRoot, 'app/ios/Kordi/Resources/emoji-catalog-v17.json'),
];
const checkOnly = process.argv.includes('--check');

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'Kordi emoji catalog generator' } });
  if (!response.ok) throw new Error(`Could not download ${url}: HTTP ${response.status}`);
  return response.text();
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

function codepointsToUnicode(codepoints) {
  return String.fromCodePoint(...codepoints);
}

function normalizeAnnotationKey(value) {
  return value.replaceAll('\ufe0f', '');
}

function parseEmojiTest(source) {
  const entries = [];
  let group = '';
  let subgroup = '';

  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.startsWith('# group:')) {
      group = line.slice('# group:'.length).trim();
      continue;
    }
    if (line.startsWith('# subgroup:')) {
      subgroup = line.slice('# subgroup:'.length).trim();
      continue;
    }
    if (!line || line.startsWith('#') || !line.includes('; fully-qualified')) continue;

    const [data, comment = ''] = line.split('#', 2);
    const [codepointField] = data.split(';', 1);
    const codepoints = codepointField.trim().split(/\s+/u).map((value) => Number.parseInt(value, 16));
    const commentMatch = comment.trim().match(/^\S+\s+E([0-9.]+)\s+(.+)$/u);
    if (!commentMatch) continue;
    const category = CATEGORY_BY_GROUP.get(group);
    if (!category) continue;

    entries.push({
      unicode: codepointsToUnicode(codepoints),
      codepoints,
      codepointKey: codepoints.map((value) => value.toString(16)).join('-'),
      fallbackName: commentMatch[2],
      category,
      subcategory: subgroup,
      emojiVersion: commentMatch[1],
    });
  }

  return entries;
}

function annotationTable(payload) {
  const table = payload?.annotations?.annotations ?? {};
  const normalized = new Map();
  for (const [emoji, annotation] of Object.entries(table)) {
    normalized.set(emoji, annotation);
    normalized.set(normalizeAnnotationKey(emoji), annotation);
  }
  return normalized;
}

async function loadLocale(locale) {
  const base = `${CLDR_SOURCE}/cldr-annotations-full/annotations/${locale.source}/annotations.json`;
  const derived = `${CLDR_SOURCE}/cldr-annotations-derived-full/annotationsDerived/${locale.source}/annotations.json`;
  const [basePayload, derivedPayload] = await Promise.all([fetchJson(base), fetchJson(derived)]);
  return new Map([...annotationTable(derivedPayload), ...annotationTable(basePayload)]);
}

function annotationFor(table, unicode, fallbackName) {
  const annotation = table.get(unicode) ?? table.get(normalizeAnnotationKey(unicode));
  const name = annotation?.tts?.[0]?.trim() || fallbackName;
  const keywords = [...new Set([
    ...(annotation?.default ?? []),
    name,
  ].map((value) => String(value).trim()).filter(Boolean))];
  return { name, keywords };
}

function withoutSkinTones(codepoints) {
  return codepoints.filter((codepoint) => !SKIN_TONE_BY_CODEPOINT.has(codepoint));
}

function skinTone(codepoints) {
  const modifiers = codepoints.filter((codepoint) => SKIN_TONE_BY_CODEPOINT.has(codepoint));
  if (modifiers.length !== 1) return null;
  return SKIN_TONE_BY_CODEPOINT.get(modifiers[0]) ?? null;
}

async function main() {
  const [emojiTest, localeTables] = await Promise.all([
    fetchText(UNICODE_SOURCE),
    Promise.all(LOCALES.map(loadLocale)),
  ]);
  const sourceEntries = parseEmojiTest(emojiTest);
  const entriesByUnicode = new Map(sourceEntries.map((entry) => [entry.unicode, entry]));
  const baseEntries = sourceEntries.filter((entry) => skinTone(entry.codepoints) === null);
  const variantsByBase = new Map();

  for (const entry of sourceEntries) {
    const tone = skinTone(entry.codepoints);
    if (!tone) continue;
    const baseUnicode = codepointsToUnicode(withoutSkinTones(entry.codepoints));
    if (!entriesByUnicode.has(baseUnicode)) continue;
    const variants = variantsByBase.get(baseUnicode) ?? [];
    variants.push({ unicode: entry.unicode, tone });
    variantsByBase.set(baseUnicode, variants);
  }

  const entries = baseEntries.map((entry) => {
    const localized = Object.fromEntries(LOCALES.map((locale, index) => [
      locale.id,
      annotationFor(localeTables[index], entry.unicode, locale.id === 'en' ? entry.fallbackName : ''),
    ]));
    const english = localized.en;
    const variants = variantsByBase.get(entry.unicode);
    return {
      unicode: entry.unicode,
      codepoints: entry.codepointKey,
      name: english.name || entry.fallbackName,
      keywords: english.keywords,
      category: entry.category,
      subcategory: entry.subcategory,
      emojiVersion: entry.emojiVersion,
      ...(variants?.length ? { variants } : {}),
      localized,
    };
  });

  const sourceSha256 = createHash('sha256').update(emojiTest).digest('hex');
  const catalog = {
    schemaVersion: 1,
    unicodeEmojiVersion: UNICODE_EMOJI_VERSION,
    cldrVersion: CLDR_VERSION,
    generatedAt: '2026-08-11T00:00:00.000Z',
    sourceSha256,
    locales: LOCALES.map((locale) => locale.id),
    entries,
  };
  const serialized = `${JSON.stringify(catalog)}\n`;

  for (const outputPath of outputPaths) {
    if (checkOnly) {
      const existing = await readFile(outputPath, 'utf8').catch(() => '');
      if (existing !== serialized) {
        throw new Error(`Generated emoji catalog is stale: ${path.relative(repoRoot, outputPath)}`);
      }
      continue;
    }
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, serialized, 'utf8');
  }

  process.stdout.write(`${checkOnly ? 'Verified' : 'Generated'} ${entries.length} base emoji records in ${outputPaths.length} targets.\n`);
}

await main();

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Owner rule: no blue or accent focus ring, glow, or outline anywhere in the
// desktop and web app. src/styles/focus.css owns the focus look; component
// styles and class names must not bring a ring back.

const desktopRoot = fileURLToPath(new URL('..', import.meta.url));
const sourceRoots = [join(desktopRoot, 'src'), join(desktopRoot, '../web/src')];
const focusCss = join(desktopRoot, 'src/styles/focus.css');

function files(root: string, pattern: RegExp): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : files(path, pattern);
    return pattern.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

type CssRule = { selector: string; body: string; atRules: string[]; line: number };

/** Flat list of style rules with their enclosing at-rules; enough for this check. */
function cssRules(source: string): CssRule[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
  const rules: CssRule[] = [];
  const walk = (start: number, end: number, atRules: string[], parent: string) => {
    let index = start;
    while (index < end) {
      const open = text.indexOf('{', index);
      if (open === -1 || open >= end) return;
      let depth = 1;
      let close = open + 1;
      for (; close < end && depth > 0; close += 1) {
        if (text[close] === '{') depth += 1;
        else if (text[close] === '}') depth -= 1;
      }
      const prelude = text.slice(index, open).split(/[;}]/).pop()!.trim();
      const body = text.slice(open + 1, close - 1);
      const line = text.slice(0, open).split('\n').length;
      if (prelude.startsWith('@')) walk(open + 1, close - 1, [...atRules, prelude], parent);
      else {
        const selector = prelude.includes('&') && parent ? prelude.replace(/&/g, parent) : prelude;
        rules.push({ selector, body: body.replace(/\{[^{}]*\}/g, ''), atRules, line });
        if (body.includes('{')) walk(open + 1, close - 1, atRules, selector);
      }
      index = close;
    }
  };
  walk(0, text.length, [], '');
  return rules;
}

function declarations(body: string) {
  return body.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const colon = part.indexOf(':');
    return { prop: part.slice(0, colon).trim().toLowerCase(), value: part.slice(colon + 1).trim() };
  });
}

const focusSelector = /:focus(?:-visible|-within)?\b/;
const accentLike = /accent|focus-ring|--forward-|--pin-|--digest-|\bsky\b|\bblue\b|(?<![\w-])highlight\b|rgb\(\s*(?:10|37|51|59|96)\s|#4977c8/i;

test('component CSS never draws a focus outline, outer ring, or accent focus color', () => {
  const problems: string[] = [];
  for (const path of files(sourceRoots[0], /\.css$/).concat(files(sourceRoots[1], /\.css$/))) {
    if (path === focusCss) continue;
    for (const rule of cssRules(readFileSync(path, 'utf8'))) {
      if (!focusSelector.test(rule.selector)) continue;
      // Windows high contrast keeps the system highlight.
      if (rule.atRules.some((atRule) => /forced-colors:\s*active/.test(atRule))) continue;
      const where = `${relative(desktopRoot, path)}:${rule.line} ${rule.selector.replace(/\s+/g, ' ').slice(0, 90)}`;
      for (const { prop, value } of declarations(rule.body)) {
        if (/^outline(?:-width|-style|-color)?$/.test(prop) && !/^(?:none|0|0px)(?:\s*!important)?$/.test(value)) problems.push(`${where}: ${prop}: ${value}`);
        if (prop === 'box-shadow') {
          for (const shadow of value.split(/,(?![^(]*\))/)) {
            const lengths = shadow.replace(/\([^)]*\)/g, '').match(/-?[\d.]+(?:px|rem)?\b/g) ?? [];
            const outerRing = !/\binset\b/.test(shadow) && lengths.length >= 4 && parseFloat(lengths[3]) > 0 && parseFloat(lengths[2]) === 0;
            if (outerRing || accentLike.test(shadow)) problems.push(`${where}: box-shadow: ${shadow.trim()}`);
          }
        }
        if (/^border(?:-(?:top|right|bottom|left))?-color$|^border(?:-bottom)?$/.test(prop) && accentLike.test(value)) problems.push(`${where}: ${prop}: ${value}`);
      }
    }
  }
  assert.deepEqual(problems, [], `focus rings found:\n${problems.join('\n')}`);
});

test('class names never add focus rings or outlines', () => {
  const pattern = /(?:^|[\s'"`])((?:[\w-]+:)*(?:focus|focus-visible|focus-within):(?:ring|outline|shadow)(?:-[^\s'"`]*)?)/g;
  const problems: string[] = [];
  for (const path of files(sourceRoots[0], /\.(?:tsx?|jsx?)$/).concat(files(sourceRoots[1], /\.(?:tsx?|jsx?)$/))) {
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(pattern)) {
      if (/:(?:outline-none|shadow-none)$/.test(match[1])) continue;
      problems.push(`${relative(desktopRoot, path)}: ${match[1]}`);
    }
  }
  assert.deepEqual(problems, [], `focus ring utilities found:\n${problems.join('\n')}`);
});

test('focus.css loads last and every legacy focus-ring token is neutral', () => {
  const index = readFileSync(join(desktopRoot, 'src/index.css'), 'utf8');
  const imports = [...index.matchAll(/@import\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
  assert.equal(imports.at(-1), './styles/focus.css');

  const focus = readFileSync(focusCss, 'utf8');
  assert.match(focus, /:focus,\s*:focus-visible\s*\{\s*outline:\s*none !important;/);
  assert.match(focus, /--app-focus-border:\s*color-mix\(in oklab, var\(--app-transient-text, currentColor\)/);
  assert.match(focus, /--app-focus-fill:\s*color-mix\(in oklab, var\(--app-transient-text, currentColor\)/);
  assert.doesNotMatch(focus.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media \(forced-colors: active\)[\s\S]*$/, ''), /accent|Highlight/);

  const tokenCss = files(join(desktopRoot, 'src'), /\.css$/).map((path) => readFileSync(path, 'utf8')).join('\n');
  const definitions = [...tokenCss.matchAll(/(--app-(?:[\w-]*focus-ring[\w-]*|cloud-login-focus-border|cloud-signin-focus|update-focus)):\s*([^;]+);/g)];
  assert.ok(definitions.length >= 10);
  for (const [, name, value] of definitions) {
    assert.ok(value.trim() === 'var(--app-focus-border)' || value.trim() === 'var(--app-transient-focus-ring)', `${name}: ${value}`);
  }
});

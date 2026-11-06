import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ErrorLine, withoutTryAgain } from '../src/components/ui/ErrorLine';

const css = (name: string) => readFileSync(new URL(`../src/styles/${name}`, import.meta.url), 'utf8');

test('ErrorLine renders one alert line without a box, icon or dismiss button', () => {
  const markup = renderToStaticMarkup(createElement(ErrorLine, null, "Couldn't create the link"));
  assert.equal(markup, '<p class="app-error-line" role="alert"><span>Couldn&#x27;t create the link</span></p>');
  assert.doesNotMatch(markup, /<svg|<button/);
});

test('ErrorLine offers one action and supports alignment and status role', () => {
  const markup = renderToStaticMarkup(createElement(ErrorLine, {
    action: { label: 'Try again', onClick: () => undefined },
    align: 'end',
    role: 'status',
  }, 'Not sent'));
  assert.match(markup, /data-align="end"/);
  assert.match(markup, /role="status"/);
  assert.match(markup, /<span class="app-error-line-separator" aria-hidden="true">·<\/span>/);
  assert.match(markup, /<button type="button" class="app-error-line-action">Try again<\/button>/);
});

test('a trailing try-again sentence is dropped when the action offers it', () => {
  assert.equal(withoutTryAgain("Couldn't create the link. Try again."), "Couldn't create the link.");
  assert.equal(withoutTryAgain('Could not delete message.'), 'Could not delete message.');
});

test('the error color token is defined for dark and light themes', () => {
  const tokens = css('theme-tokens.css');
  const dark = tokens.match(/:where\(body, \.kordi-app\) \{[^}]*\}/s)?.[0] ?? '';
  const light = tokens.match(/:where\(body\.theme-light[^{]*\{[^}]*\}/s)?.[0] ?? '';
  assert.match(dark, /--app-error-text:\s*rgb\(253 164 175\);/);
  assert.match(light, /--app-error-text:\s*rgb\(159 18 57\);/);
  for (const block of [dark, light]) assert.match(block, /--app-danger-text:\s*var\(--app-error-text\);/);
});

test('error text and ErrorLine use the shared token', () => {
  assert.match(css('base.css'), /:where\(\.app-error-text\)\s*\{\s*color:\s*var\(--app-error-text\);/);
  const line = css('error-line.css');
  assert.match(line, /\.app-error-line\s*\{[^}]*color:\s*var\(--app-error-text\);[^}]*font-size:\s*12px;/s);
  assert.doesNotMatch(line, /border:\s*1px|background:(?!\s*none)/);
});

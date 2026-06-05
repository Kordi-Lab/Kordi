import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { DesktopUpdateButton } from '../src/features/update/DesktopUpdateButton';

test('DesktopUpdateButton renders a compact blue Update button when update is available', () => {
  const html = renderToStaticMarkup(
    <DesktopUpdateButton state={{ kind: 'available', version: '0.0.1-beta.4', currentVersion: '0.0.1-beta.3' }} onUpdate={() => {}} onRestart={() => {}} onCancel={() => {}} />,
  );

  assert.match(html, /Update/);
  assert.match(html, /app-update-button/);
  assert.doesNotMatch(html, /Kordi update available/);
});

test('DesktopUpdateButton keeps progress compact while downloading', () => {
  const html = renderToStaticMarkup(
    <DesktopUpdateButton state={{ kind: 'downloading', version: '0.0.1-beta.4', downloaded: 40, total: 100, percent: 40 }} onUpdate={() => {}} onRestart={() => {}} onCancel={() => {}} />,
  );

  assert.match(html, /40%/);
  assert.doesNotMatch(html, /Downloads quietly/);
});

test('DesktopUpdateButton asks to restart or cancel after install', () => {
  const html = renderToStaticMarkup(
    <DesktopUpdateButton state={{ kind: 'ready', version: '0.0.1-beta.4' }} onUpdate={() => {}} onRestart={() => {}} onCancel={() => {}} />,
  );

  assert.match(html, /Update installed/);
  assert.match(html, /Restart/);
  assert.match(html, /Cancel/);
});

test('DesktopUpdateButton shows a GitHub fallback on failure', () => {
  const html = renderToStaticMarkup(
    <DesktopUpdateButton state={{ kind: 'failed', message: 'signature missing', fallbackUrl: 'https://github.com/Kordi-AI/Kordi/releases' }} onUpdate={() => {}} onRestart={() => {}} onCancel={() => {}} />,
  );

  assert.match(html, /signature missing/);
  assert.match(html, /GitHub/);
  assert.match(html, /https:\/\/github.com\/Kordi-AI\/Kordi\/releases/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ScheduledTasksPanel } from '../src/kordi-app/components/ScheduledTasksPanel';

test('scheduled tasks panel renders management actions and waiting for desktop state', () => {
  const markup = renderToStaticMarkup(createElement(ScheduledTasksPanel, {
    tasks: [{
      taskId: 'task1',
      title: 'Morning local check',
      prompt: 'Check my Downloads folder.',
      schedule: { kind: 'daily', time: '09:00', timezone: 'UTC' },
      targetRuntime: 'local_required',
      enabled: true,
      status: 'active',
      nextRunAt: '2026-06-09T09:00:00Z',
      lastRunAt: '2026-06-08T09:00:00Z',
      lastRunStatus: 'waiting_for_desktop',
      lastRunError: null,
      createdAt: '2026-06-08T08:00:00Z',
      updatedAt: '2026-06-08T08:00:00Z',
    }],
    onPause: () => {},
    onResume: () => {},
    onRunNow: () => {},
    onDelete: () => {},
  }));

  assert.match(markup, /Scheduled tools/);
  assert.match(markup, /Morning local check/);
  assert.match(markup, /Daily at 09:00 UTC/);
  assert.match(markup, /Requires Desktop/);
  assert.match(markup, /Waiting for Desktop/);
  assert.match(markup, /Pause/);
  assert.match(markup, /Run now/);
  assert.match(markup, /Delete/);
});

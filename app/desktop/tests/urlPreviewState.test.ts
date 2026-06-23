import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseKordiUrlPreviewState } from '../src/app/urlPreviewState';

test('URL preview state is inert unless explicitly enabled', () => {
  assert.deepEqual(parseKordiUrlPreviewState('?theme=light&view=agents'), { enabled: false });
});

test('URL preview state accepts stable light and dark theme review params', () => {
  assert.deepEqual(parseKordiUrlPreviewState('?kordi-preview=1&theme=light&view=chats&detail=tasks'), {
    enabled: true,
    themeMode: 'light',
    activeNav: 'chats',
    activeDetailTab: 'tasks',
    activeConvId: undefined,
    activeContactGroup: undefined,
    activeContactId: undefined,
    activeAgentId: undefined,
    activeSettingsSectionId: undefined,
  });

  assert.deepEqual(parseKordiUrlPreviewState('?preview=ui&theme=dark&nav=settings&settings=appearance'), {
    enabled: true,
    themeMode: 'dark',
    activeNav: 'settings',
    activeDetailTab: undefined,
    activeConvId: undefined,
    activeContactGroup: undefined,
    activeContactId: undefined,
    activeAgentId: undefined,
    activeSettingsSectionId: 'appearance',
  });
});

test('URL preview state ignores invalid enum values while preserving explicit ids', () => {
  assert.deepEqual(parseKordiUrlPreviewState('?kordi-preview=true&theme=system&view=unknown&detail=bad&session=abc&contactGroup=nope&contact=user-1&agent=agent-1'), {
    enabled: true,
    themeMode: undefined,
    activeNav: undefined,
    activeDetailTab: undefined,
    activeConvId: 'abc',
    activeContactGroup: undefined,
    activeContactId: 'user-1',
    activeAgentId: 'agent-1',
    activeSettingsSectionId: undefined,
  });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { OrganizationSwitcherRows } from '../src/features/organizations/OrganizationSwitcher';
import type { CloudOrganization } from '../src/features/organizations/organizationClient';

const personal: CloudOrganization = {
  organizationId: 'org_personal_a', name: 'Personal', kind: 'personal', role: 'owner', memberCount: 1,
};
const team: CloudOrganization = {
  organizationId: 'org_team_example', name: 'Example team', kind: 'team', role: 'member', memberCount: 3,
};

test('the switcher is hidden when the account has only its personal organization', () => {
  assert.equal(renderToStaticMarkup(
    <OrganizationSwitcherRows organizations={[personal]} selectedOrganizationId={personal.organizationId} onSelect={() => {}} />,
  ), '');
  assert.equal(renderToStaticMarkup(
    <OrganizationSwitcherRows organizations={[]} selectedOrganizationId={null} onSelect={() => {}} />,
  ), '');
});

test('the switcher lists only the returned organizations and marks the selected one', () => {
  const markup = renderToStaticMarkup(
    <OrganizationSwitcherRows
      organizations={[personal, team]}
      selectedOrganizationId={team.organizationId}
      onSelect={() => {}}
    />,
  );
  const rows = [...markup.matchAll(/data-organization-id="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(rows, [personal.organizationId, team.organizationId]);
  assert.match(markup, /aria-pressed="false"[^>]*data-organization-id="org_personal_a"/);
  assert.match(markup, /aria-pressed="true"[^>]*data-organization-id="org_team_example"/);
  assert.match(markup, />Personal</);
  assert.match(markup, />Example team</);
  assert.doesNotMatch(markup, /uppercase/);
  assert.equal((markup.match(/<svg/g) ?? []).length, 1);
});

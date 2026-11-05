import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { OrganizationMenuEntry, OrganizationMenuPanel } from '../src/features/organizations/OrganizationSwitcher';
import type { CloudOrganization } from '../src/features/organizations/organizationClient';

const personal: CloudOrganization = {
  organizationId: 'org_personal_a', name: 'Personal', kind: 'personal', role: 'owner', memberCount: 1,
};
const team: CloudOrganization = {
  organizationId: 'org_team_example', name: 'Example team', kind: 'team', role: 'member', memberCount: 3,
};

const noop = () => {};

test('the first level is hidden when the server returned no organizations', () => {
  assert.equal(renderToStaticMarkup(
    <OrganizationMenuEntry organizations={[]} selectedOrganizationId={null} onOpen={noop} />,
  ), '');
});

test('the first level shows only the current organization on one row', () => {
  const markup = renderToStaticMarkup(
    <OrganizationMenuEntry organizations={[personal, team]} selectedOrganizationId={team.organizationId} onOpen={noop} />,
  );
  const rows = [...markup.matchAll(/data-organization-id="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(rows, [team.organizationId]);
  assert.match(markup, />Example team</);
  assert.match(markup, />3</);
  assert.doesNotMatch(markup, /Personal/);
  assert.doesNotMatch(markup, /members/);
});

test('an account with only its personal organization still reaches the list', () => {
  const markup = renderToStaticMarkup(
    <OrganizationMenuEntry organizations={[personal]} selectedOrganizationId={personal.organizationId} onOpen={noop} />,
  );
  assert.match(markup, /aria-haspopup="menu"/);
  assert.match(markup, />Personal</);
});

test('the second level lists every organization, marks the current one and offers joining', () => {
  const markup = renderToStaticMarkup(
    <OrganizationMenuPanel
      organizations={[personal, team]}
      selectedOrganizationId={team.organizationId}
      onSelect={noop}
      onFind={noop}
      onBack={noop}
    />,
  );
  const rows = [...markup.matchAll(/data-organization-id="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(rows, [personal.organizationId, team.organizationId]);
  assert.match(markup, /aria-pressed="false"[^>]*data-organization-id="org_personal_a"/);
  assert.match(markup, /aria-pressed="true"[^>]*data-organization-id="org_team_example"/);
  assert.match(markup, /aria-label="Back"/);
  assert.match(markup, />Find your organization</);
  assert.doesNotMatch(markup, /uppercase/);
});

test('the second level falls back to the personal organization when nothing is selected', () => {
  const markup = renderToStaticMarkup(
    <OrganizationMenuPanel
      organizations={[personal, team]}
      selectedOrganizationId={null}
      onSelect={noop}
      onFind={noop}
      onBack={noop}
    />,
  );
  assert.match(markup, /aria-pressed="true"[^>]*data-organization-id="org_personal_a"/);
});

// Login-free preview of the real "find your organization" dialog with synthetic data.
// Nothing is sent anywhere: the actions resolve locally after a short delay.
//   ?state=list        three organizations: Join, Request to join, already Requested (default)
//   ?state=one         a single organization
//   ?state=empty       no organization uses the verified email domain
//   ?state=unverified  the account has no verified email
//   ?state=loading     the list is still loading
//   ?theme=dark        dark appearance (default light, Classic chat theme)
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { OrganizationJoinDialog, type OrganizationJoinActions } from '../../src/features/organizations/OrganizationJoinDialog';
import type { JoinableOrganization, JoinableOrganizations } from '../../src/features/organizations/organizationJoinClient';
import '../../src/index.css';
import './organizationJoinPage.css';

const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const state = params.get('state') ?? 'list';

document.body.dataset.kordiChatTheme = 'classic';
document.body.classList.toggle('theme-light', theme === 'light');
document.body.classList.toggle('theme-dark', theme === 'dark');
document.documentElement.style.colorScheme = theme;

const ALL: JoinableOrganization[] = [
  {
    id: 'harbor', organizationId: 'org_harbor', name: 'Harbor Research', memberCount: 128,
    canJoin: true, canRequest: true, requested: false, joinRequestFields: [],
  },
  {
    id: 'maple', organizationId: 'org_maple', name: 'Maple Lab', memberCount: 24,
    canJoin: false, canRequest: true, requested: false,
    joinRequestFields: [
      { key: 'team', label: 'Team', required: true, maxLength: 80 },
      { key: 'note', label: 'Note', required: false, maxLength: 400 },
    ],
  },
  {
    id: 'cedar', organizationId: 'org_cedar', name: 'Cedar Studio', memberCount: 9,
    canJoin: false, canRequest: false, requested: true, joinRequestFields: [],
  },
];

function fixture(): JoinableOrganizations | null {
  if (state === 'loading') return null;
  if (state === 'unverified') return { email: null, emailDomain: null, organizations: [] };
  const organizations = state === 'empty' ? [] : state === 'one' ? ALL.slice(0, 1) : ALL;
  return { email: 'pat@example.test', emailDomain: 'example.test', organizations };
}

const DATA = fixture();
const later = <T,>(value: T) => new Promise<T>((resolve) => { setTimeout(() => resolve(value), 400); });
const actions: OrganizationJoinActions = {
  sendCode: () => later('ver_preview'),
  verifyCode: () => later(undefined),
  request: () => later(undefined),
};

function OrganizationJoinPreview() {
  const [open, setOpen] = useState(true);
  return (
    <main className={`kordi-app theme-${theme} org-join-visual-shell`}>
      {open ? <OrganizationJoinDialog data={DATA} actions={actions} onClose={() => setOpen(false)} /> : (
        <button type="button" className="m-6 rounded-lg border px-3 py-1.5 text-[12px]" onClick={() => setOpen(true)}>Open dialog</button>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><OrganizationJoinPreview /></StrictMode>);

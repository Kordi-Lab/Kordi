import { Check, ChevronLeft, ChevronRight, Search, UserRound } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { CloudOrganization } from './organizationClient';

// One-line menu rows: the account menu lists organizations, it does not describe them.
const ROW = 'app-button-quiet app-transient-flat-action app-transient-action-row org-menu-row grid items-center gap-x-2 rounded-[8px] px-2 text-left';

function memberCount(organization: CloudOrganization): string {
  return organization.kind === 'team' ? String(organization.memberCount) : '';
}

function OrganizationMark({ organization }: { organization: CloudOrganization }) {
  return (
    <span className="org-menu-mark" aria-hidden="true">
      {organization.kind === 'personal' ? <UserRound /> : organization.name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

function currentOrganization(
  organizations: CloudOrganization[],
  selectedOrganizationId: string | null,
): CloudOrganization | null {
  return organizations.find((organization) => organization.organizationId === selectedOrganizationId)
    ?? organizations.find((organization) => organization.kind === 'personal')
    ?? organizations[0]
    ?? null;
}

/** First level: the current organization, opening the list in place. */
export function OrganizationMenuEntry({
  organizations,
  selectedOrganizationId,
  onOpen,
}: {
  organizations: CloudOrganization[];
  selectedOrganizationId: string | null;
  onOpen: () => void;
}) {
  const current = currentOrganization(organizations, selectedOrganizationId);
  // Older servers and offline starts return no organizations.
  if (!current) return null;
  return (
    <div className="app-transient-divider mt-2 grid border-t pt-2">
      <button
        type="button"
        className={cn(ROW, 'grid-cols-[1.25rem_minmax(0,1fr)_auto_0.875rem]')}
        aria-haspopup="menu"
        aria-label={`Organization: ${current.name}`}
        data-organization-id={current.organizationId}
        onClick={onOpen}
      >
        <OrganizationMark organization={current} />
        <span className="app-transient-action-label truncate">{current.name}</span>
        <span className="app-transient-metadata tabular-nums">{memberCount(current)}</span>
        <ChevronRight className="app-transient-action-icon app-transient-subtle" aria-hidden="true" />
      </button>
    </div>
  );
}

/** Second level: every organization of the account, then joining another one. */
export function OrganizationMenuPanel({
  organizations,
  selectedOrganizationId,
  onSelect,
  onFind,
  onBack,
}: {
  organizations: CloudOrganization[];
  selectedOrganizationId: string | null;
  onSelect: (organizationId: string) => void;
  onFind: () => void;
  onBack: () => void;
}) {
  const current = currentOrganization(organizations, selectedOrganizationId);
  return (
    <div className="org-menu-panel">
      <div className="grid grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-x-2 px-2 pb-1">
        <button
          type="button"
          className="app-button-quiet app-transient-flat-action -ml-0.5 grid h-6 w-6 place-items-center rounded-[6px]"
          aria-label="Back"
          onClick={onBack}
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <span className="app-transient-action-label org-menu-title truncate">Organizations</span>
      </div>
      <div className="app-transient-divider grid gap-px border-t pt-1" role="group" aria-label="Organizations">
        {organizations.map((organization) => {
          const selected = organization.organizationId === current?.organizationId;
          return (
            <button
              key={organization.organizationId}
              type="button"
              className={cn(ROW, 'grid-cols-[1.25rem_minmax(0,1fr)_auto_0.875rem]')}
              aria-pressed={selected}
              data-organization-id={organization.organizationId}
              onClick={() => onSelect(organization.organizationId)}
            >
              <OrganizationMark organization={organization} />
              <span className="app-transient-action-label truncate">{organization.name}</span>
              <span className="app-transient-metadata tabular-nums">{memberCount(organization)}</span>
              {selected ? <Check className="app-transient-action-icon" aria-hidden="true" /> : <span aria-hidden="true" />}
            </button>
          );
        })}
      </div>
      <div className="app-transient-divider mt-1 grid border-t pt-1">
        <button type="button" className={cn(ROW, 'grid-cols-[1.25rem_minmax(0,1fr)]')} onClick={onFind}>
          <span className="grid h-5 w-5 place-items-center" aria-hidden="true">
            <Search className="app-transient-action-icon app-transient-muted" />
          </span>
          <span className="app-transient-action-label truncate">Find your organization</span>
        </button>
      </div>
    </div>
  );
}

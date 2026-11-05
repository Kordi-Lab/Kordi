import { Check } from 'lucide-react';

import type { CloudOrganization } from './organizationClient';

export function OrganizationSwitcherRows({
  organizations,
  selectedOrganizationId,
  onSelect,
}: {
  organizations: CloudOrganization[];
  selectedOrganizationId: string | null;
  onSelect: (organizationId: string) => void;
}) {
  // An account that belongs only to its personal organization has nothing to switch.
  if (!organizations.some((organization) => organization.kind === 'team')) return null;
  return (
    <div className="app-transient-divider mt-2 grid gap-1 border-t pt-2" role="group" aria-label="Organization">
      {organizations.map((organization) => {
        const selected = organization.organizationId === selectedOrganizationId;
        return (
          <button
            key={organization.organizationId}
            type="button"
            className="app-button-quiet app-transient-flat-action app-transient-action-row app-account-popover-row grid grid-cols-[minmax(0,1fr)_1.75rem] items-center gap-x-2.5 rounded-[12px] px-2.5 py-2 text-left"
            aria-pressed={selected}
            data-organization-id={organization.organizationId}
            onClick={() => onSelect(organization.organizationId)}
          >
            <span className="app-transient-action-label truncate">{organization.name}</span>
            <span className="grid h-7 w-7 place-items-center justify-self-end" aria-hidden="true">
              {selected ? <Check className="app-transient-action-icon app-transient-muted" /> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

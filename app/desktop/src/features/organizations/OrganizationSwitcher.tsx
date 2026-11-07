import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Check, ChevronRight, Search, UserRound, X } from 'lucide-react';

import type { CloudOrganization } from './organizationClient';

// One-line dense rows, as in the Help menu: the account menu lists organizations, it does not describe them.
const ROW = 'app-dense-menu-row org-menu-row';

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
    <>
      <div className="app-dense-menu-divider" />
      <div className="app-dense-menu-items">
        <button
          type="button"
          className={ROW}
          aria-haspopup="menu"
          aria-label={`Organization: ${current.name}`}
          data-organization-id={current.organizationId}
          onClick={onOpen}
        >
          <OrganizationMark organization={current} />
          <span className="truncate">{current.name}</span>
          <span className="app-dense-menu-meta">{memberCount(current)}</span>
          <ChevronRight aria-hidden="true" />
        </button>
      </div>
    </>
  );
}

/** Second level: every organization of the account, then joining another one. */
export function OrganizationMenuPanel({
  organizations,
  selectedOrganizationId,
  onSelect,
  onFind,
  onBack,
  onClose,
}: {
  organizations: CloudOrganization[];
  selectedOrganizationId: string | null;
  onSelect: (organizationId: string) => void;
  onFind: () => void;
  onBack: () => void;
  onClose?: () => void;
}) {
  const current = currentOrganization(organizations, selectedOrganizationId);
  return (
    <div className="org-menu-panel">
      <div className="app-dense-menu-header">
        <button type="button" aria-label="Back" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
        </button>
        <span className="app-dense-menu-title">Organizations</span>
        {onClose ? (
          <button type="button" aria-label="Close account menu" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <div className="app-dense-menu-items" role="group" aria-label="Organizations">
        {organizations.map((organization) => {
          const selected = organization.organizationId === current?.organizationId;
          return (
            <button
              key={organization.organizationId}
              type="button"
              className={ROW}
              aria-pressed={selected}
              data-organization-id={organization.organizationId}
              onClick={() => onSelect(organization.organizationId)}
            >
              <OrganizationMark organization={organization} />
              <span className="truncate">{organization.name}</span>
              <span className="app-dense-menu-meta">{memberCount(organization)}</span>
              {selected ? <Check aria-hidden="true" /> : <span className="org-menu-check-space" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
      <div className="app-dense-menu-divider" />
      <div className="app-dense-menu-items">
        <button type="button" className={ROW} onClick={onFind}>
          <span className="org-menu-mark org-menu-mark-plain" aria-hidden="true"><Search /></span>
          <span className="truncate">Find your organization</span>
        </button>
      </div>
    </div>
  );
}

type MenuLevel = { level: 'account' | 'organizations'; direction: 'forward' | 'back' | null };

/**
 * The account menu body with organizations as its second level. It mounts with
 * the menu, so every opening starts at the first level. While the list is shown,
 * Escape steps back instead of closing the menu.
 */
export function OrganizationMenuLevels({
  organizations,
  selectedOrganizationId,
  onSelect,
  onFind,
  onClose,
  children,
}: {
  organizations: CloudOrganization[];
  selectedOrganizationId: string | null;
  onSelect: (organizationId: string) => void;
  onFind: () => void;
  /** Closes the whole menu from the organization list's header. */
  onClose?: () => void;
  children: (organizationEntry: ReactNode) => ReactNode;
}) {
  const [menu, setMenu] = useState<MenuLevel>({ level: 'account', direction: null });
  const levelRef = useRef<HTMLDivElement | null>(null);
  const back = () => setMenu({ level: 'account', direction: 'back' });

  // The focused row unmounts when the level changes; keep keyboard focus in the menu.
  useEffect(() => {
    if (menu.direction === null) return;
    const container = levelRef.current;
    const target = menu.level === 'organizations'
      ? container?.querySelector<HTMLElement>('[aria-pressed="true"]') ?? container?.querySelector<HTMLElement>('button')
      : container?.querySelector<HTMLElement>('[aria-haspopup="menu"]');
    target?.focus({ preventScroll: true });
  }, [menu]);

  useEffect(() => {
    if (menu.level !== 'organizations') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Runs before the menu's own Escape handler, which would close the menu.
      event.stopPropagation();
      setMenu({ level: 'account', direction: 'back' });
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [menu.level]);

  if (menu.level === 'organizations') {
    return (
      <div ref={levelRef} className="org-menu-level" data-direction={menu.direction ?? undefined} key="organizations">
        <OrganizationMenuPanel
          organizations={organizations}
          selectedOrganizationId={selectedOrganizationId}
          onSelect={(organizationId) => {
            onSelect(organizationId);
            back();
          }}
          onFind={onFind}
          onBack={back}
          onClose={onClose}
        />
      </div>
    );
  }
  return (
    <div ref={levelRef} className="org-menu-level" data-direction={menu.direction ?? undefined} key="account">
      {children(
        <OrganizationMenuEntry
          organizations={organizations}
          selectedOrganizationId={selectedOrganizationId}
          onOpen={() => setMenu({ level: 'organizations', direction: 'forward' })}
        />,
      )}
    </div>
  );
}

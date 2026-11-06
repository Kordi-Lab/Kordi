import type { CloudContactPermissionFlags } from '@/features/cloud/contactProfileClient';
import { SettingsSwitch } from '../components/settingsLayout';
import { SectionLabel } from './ContactProfileCards';
import type { ContactPermissionsHost } from './contactProfileHost';
import { useContactPermissions, type ContactPermissionKey } from './useContactPermissions';

const ROWS: Array<{ key: ContactPermissionKey; label: string }> = [
  { key: 'agentAccess', label: 'Use my agent' },
  { key: 'cardAccess', label: 'See my card' },
];

/** The two per-person switches, as a card under a "Permissions" label. */
export function ContactPermissionsSection({
  flags,
  saving = {},
  error = '',
  onToggle,
}: {
  flags: CloudContactPermissionFlags;
  saving?: Partial<Record<ContactPermissionKey, boolean>>;
  error?: string;
  onToggle: (key: ContactPermissionKey, next: boolean) => void;
}) {
  return (
    <>
      <SectionLabel>Permissions</SectionLabel>
      <div className="app-contacts-card app-contacts-permissions rounded-[12px]" role="group" aria-label="Permissions">
        {ROWS.map((row) => (
          <div key={row.key} className="app-contacts-card-row flex min-h-[44px] items-center gap-3 pl-4 pr-3.5">
            <span className="min-w-0 flex-1 truncate text-[14px]">{row.label}</span>
            <SettingsSwitch
              enabled={flags[row.key]}
              label={row.label}
              // A save in flight ignores further clicks without dimming the switch.
              onChange={(next) => { if (!saving[row.key]) onToggle(row.key, next); }}
            />
          </div>
        ))}
      </div>
      {error ? (
        <div className="app-error-text app-contacts-error mx-1 mt-2 text-[12px] leading-5" aria-live="polite">{error}</div>
      ) : null}
    </>
  );
}

/** Loads the flags (unless the profile carried them) and saves each switch as it changes. */
export function ContactPermissionsCard({
  accountId,
  initial,
  host,
}: {
  accountId: string;
  initial: CloudContactPermissionFlags | null | undefined;
  host: ContactPermissionsHost;
}) {
  const { flags, saving, error, toggle } = useContactPermissions(accountId, initial, host);
  if (!flags) return null;
  return <ContactPermissionsSection flags={flags} saving={saving} error={error} onToggle={toggle} />;
}

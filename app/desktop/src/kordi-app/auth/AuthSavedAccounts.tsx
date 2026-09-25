import { useEffect, useRef, useState } from 'react';
import { formatDesktopDateTime } from '@/lib/time';
import { SettingsRow, SettingsSection } from '@/kordi-app/components/settingsLayout';
import { AuthActionButton, authActiveBadgeClass, authButtonDangerClass, authButtonNeutralClass } from './AuthDetailPrimitives';
import type { AuthDisplayMethod, AuthDisplayProvider } from './model';
import { CUSTOM_MODEL_REQUIRED, customApiAccountSummary } from './customApiAccount';
import { savedAccountMethodLabel } from './providerCopy';

function formatAuthTimestamp(timestampMs?: number | null) {
  if (!timestampMs) return null;
  try {
    return formatDesktopDateTime(timestampMs);
  } catch {
    return null;
  }
}

type AuthSavedAccountsProps = {
  provider: AuthDisplayProvider;
  /** Auth choices added in this visit, shown with a brief "Added" badge. */
  recentlyAdded?: string[];
  /** Auth choices whose hosted copy needs the owner to sign in again. */
  needsReconnect?: string[];
  onReconnect?: (option: AuthDisplayMethod['options'][number], method: AuthDisplayMethod) => void;
  /** Custom API accounts: change the model, which re-publishes the account. */
  onEdit?: (option: AuthDisplayMethod['options'][number]) => void;
  onSelectAuthChoice: (providerId: string, choice: string) => void;
  onRemoveAuthProfile: (providerId: string, profileId: string) => void;
};

/** One row per saved account: name, method, active badge and a remove control. */
export function AuthSavedAccounts({ provider, recentlyAdded = [], needsReconnect = [], onReconnect, onEdit, onSelectAuthChoice, onRemoveAuthProfile }: AuthSavedAccountsProps) {
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);
  const rowsRef = useRef(new Map<string, HTMLDivElement>());
  const accounts = provider.methods.flatMap((method) => method.options.map((option) => ({ method, option })));
  const latestAdded = recentlyAdded[recentlyAdded.length - 1] ?? null;
  const latestShown = accounts.some(({ option }) => option.value === latestAdded);

  // Returning from an add-account page brings the new row into view.
  useEffect(() => {
    if (latestAdded && latestShown) rowsRef.current.get(latestAdded)?.scrollIntoView?.({ block: 'nearest' });
  }, [latestAdded, latestShown]);

  if (!accounts.some(({ option }) => option.profileId)) return null;

  return (
    <SettingsSection title="Saved accounts" className="app-auth-detail-section">
      {accounts.map(({ method, option }) => {
        const removalKey = `${option.providerId}:${option.profileId ?? option.value}`;
        const updated = formatAuthTimestamp(option.updatedAtMs);
        const reconnectNeeded = needsReconnect.includes(option.value);
        const custom = provider.id === 'custom';
        const modelMissing = custom && !option.modelHint?.trim();
        return (
          <div
            key={`${option.providerId}-${option.value}`}
            ref={(node) => { if (node) rowsRef.current.set(option.value, node); else rowsRef.current.delete(option.value); }}
            role="group"
            aria-label={option.label}
          >
            <SettingsRow
              title={option.label}
              description={(
                <>
                  {custom ? customApiAccountSummary(option.modelHint) : savedAccountMethodLabel(provider, method)}
                  {option.source === 'Cloud' ? ' · Hosted in your Kordi account' : ' · On this Mac'}
                  {updated ? ` · Last active ${updated}` : ''}
                  {reconnectNeeded ? <span className="block text-amber-200">Account needs reconnecting</span> : null}
                  {modelMissing ? <span className="block text-amber-200">{CUSTOM_MODEL_REQUIRED}</span> : null}
                </>
              )}
              control={(
                <>
                  {recentlyAdded.includes(option.value) ? (
                    <span className="app-auth-badge-added inline-flex h-7 items-center rounded-full border border-emerald-300/30 px-2.5 text-[11px] font-medium text-emerald-200">Added</span>
                  ) : null}
                  {custom && onEdit ? (
                    <AuthActionButton type="button" className={authButtonNeutralClass} onClick={() => onEdit(option)}>Edit</AuthActionButton>
                  ) : null}
                  {reconnectNeeded ? (
                    <AuthActionButton type="button" className={authButtonNeutralClass} onClick={() => onReconnect?.(option, method)}>
                      Reconnect
                    </AuthActionButton>
                  ) : option.active ? (
                    <span className={authActiveBadgeClass}>Active</span>
                  ) : option.source === 'Cloud' ? (
                    <span className="app-auth-badge-hosted inline-flex h-7 items-center rounded-full border border-white/10 px-2.5 text-[11px] font-medium text-slate-300">Hosted</span>
                  ) : (
                    <AuthActionButton type="button" className={authButtonNeutralClass} onClick={() => onSelectAuthChoice(option.providerId, option.value)}>
                      {option.profileId ? 'Use this profile' : 'Use environment'}
                    </AuthActionButton>
                  )}
                  {!option.profileId ? (
                    <span className="app-badge-neutral rounded-full px-2.5 py-0.5 text-[10px] leading-none">Environment</span>
                  ) : pendingRemoval === removalKey ? (
                    <>
                      <AuthActionButton
                        type="button"
                        className={authButtonDangerClass}
                        onClick={() => {
                          setPendingRemoval(null);
                          onRemoveAuthProfile(option.providerId, option.profileId!);
                        }}
                      >
                        Confirm remove
                      </AuthActionButton>
                      <AuthActionButton type="button" className={authButtonNeutralClass} onClick={() => setPendingRemoval(null)}>
                        Keep
                      </AuthActionButton>
                    </>
                  ) : (
                    <AuthActionButton type="button" className={authButtonDangerClass} onClick={() => setPendingRemoval(removalKey)}>
                      Remove
                    </AuthActionButton>
                  )}
                </>
              )}
            />
          </div>
        );
      })}
    </SettingsSection>
  );
}

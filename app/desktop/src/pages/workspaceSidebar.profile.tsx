import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, Settings } from 'lucide-react';

import { cloudAvatarImageUrl, cloudAvatarSeedForAccount } from '@/features/cloud/avatar';
import { IdentityAvatar, useLocalProfileAvatarSeed } from '@/kordi-app/components/IdentityAvatar';
import { cn } from '@/lib/utils';
import {
  CloudAccountSettingsDialog,
  type CloudAccountSettingsTabId,
} from '@/pages/CloudAccountSettingsDialog';
import type { WorkspaceSidebarAccount } from '@/pages/workspaceSidebar.types';
import { buildCloudProfileRows } from '@/pages/workspaceSidebar.profileModel';
import { ChevronRight as ChevronRightIcon } from 'lucide-react';

const CLOUD_PROFILE_COPY_RESET_MS = 1800;

export function CloudProfileRowCopyButton({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
  }, []);

  const scheduleReset = () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => {
      setStatus('idle');
      resetTimerRef.current = null;
    }, CLOUD_PROFILE_COPY_RESET_MS);
  };

  const handleCopy = async () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      setStatus('error');
      scheduleReset();
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      setStatus('copied');
    } catch {
      setStatus('error');
    } finally {
      scheduleReset();
    }
  };

  const copied = status === 'copied';
  const errored = status === 'error';
  return (
    <button
      type="button"
      className={cn(
        'shrink-0 inline-flex items-center gap-1 rounded-[8px] px-2 py-1 text-[11px] font-semibold transition',
        copied
          ? 'bg-emerald-500/15 text-emerald-200'
          : errored
            ? 'bg-red-500/15 text-red-200'
            : 'app-transient-row',
      )}
      aria-label={copied
        ? `${label} copied`
        : errored
          ? `Copy ${label} failed`
          : `Copy ${label}`}
      aria-live="polite"
      onClick={() => {
        void handleCopy();
      }}
    >
      {copied ? <Check className="h-3 w-3" aria-hidden="true" /> : null}
      {copied ? 'Copied' : errored ? 'Copy failed' : 'Copy'}
    </button>
  );
}

export function CloudProfileLogoutAction({
  onSignOut,
  disabled = false,
}: {
  onSignOut: () => Promise<void> | void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={cn(
        'flex w-full items-center justify-between rounded-[12px] px-3 py-2.5 text-left text-[12px] font-semibold text-red-200',
        'transition hover:bg-red-400/10 hover:text-red-100 disabled:cursor-not-allowed disabled:opacity-60',
      )}
      aria-label="Logout of account"
      disabled={disabled}
      onClick={() => void onSignOut()}
    >
      <span>Logout</span>
    </button>
  );
}

export function SidebarProfileControl({
  localProfileAvatarSeed,
  cloudAccount,
  cloudAccountDialogTab: controlledDialogTab,
  setCloudAccountDialogTab: setControlledDialogTab,
  cloudSettings,
  onUpdateCloudProfile,
  onCloudSignOut,
}: WorkspaceSidebarAccount) {
  const [isProfileCardOpen, setIsProfileCardOpen] = useState(false);
  const [localDialogTab, setLocalDialogTab] = useState<CloudAccountSettingsTabId | null>(null);
  const isDialogControlled = Boolean(setControlledDialogTab);
  const dialogTab = isDialogControlled ? (controlledDialogTab ?? null) : localDialogTab;
  const setDialogTab = setControlledDialogTab ?? setLocalDialogTab;
  const profileTriggerRef = useRef<HTMLButtonElement | null>(null);
  const profilePopoverRef = useRef<HTMLDivElement | null>(null);
  const [popoverAnchor, setPopoverAnchor] = useState<{
    left: number;
    bottom: number;
  } | null>(null);
  const currentLocalProfileAvatarSeed = useLocalProfileAvatarSeed();
  const profileRows = buildCloudProfileRows(cloudAccount);
  const profileDisplayName = cloudAccount?.displayName?.trim()
    || cloudAccount?.primaryEmail?.trim()
    || 'Local profile';
  const profileAvatarSeed = cloudAccount
    ? cloudAvatarSeedForAccount(cloudAccount.accountId, cloudAccount.avatarUrl)
    : localProfileAvatarSeed || currentLocalProfileAvatarSeed;
  const profileImageUrl = cloudAccount ? cloudAvatarImageUrl(cloudAccount.avatarUrl) : null;

  useLayoutEffect(() => {
    if (!isProfileCardOpen) return;
    const trigger = profileTriggerRef.current;
    if (!trigger) return;
    const measure = () => {
      const rect = trigger.getBoundingClientRect();
      setPopoverAnchor({
        left: rect.right + 8,
        bottom: Math.max(8, window.innerHeight - rect.bottom),
      });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [isProfileCardOpen]);

  useEffect(() => {
    if (!isProfileCardOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (profilePopoverRef.current?.contains(target)) return;
      if (profileTriggerRef.current?.contains(target)) return;
      setIsProfileCardOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsProfileCardOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isProfileCardOpen]);

  const openCloudAccountDialog = (tab: CloudAccountSettingsTabId) => {
    setIsProfileCardOpen(false);
    setDialogTab(tab);
  };

  return (
    <>
      <button
        ref={profileTriggerRef}
        type="button"
        className="app-nav-rail-profile rounded-full"
        onClick={() => setIsProfileCardOpen((open) => !open)}
        aria-label="Open profile"
        aria-expanded={isProfileCardOpen}
      >
        <IdentityAvatar
          kind="human"
          seed={profileAvatarSeed}
          name={profileDisplayName}
          imageUrl={profileImageUrl}
          className="app-nav-rail-avatar h-9 w-9"
        />
      </button>

      {cloudSettings && cloudAccount && onUpdateCloudProfile ? (
        <CloudAccountSettingsDialog
          {...cloudSettings}
          isOpen={dialogTab !== null}
          initialTab={dialogTab ?? 'profile'}
          account={cloudAccount}
          localProfileAvatarSeed={localProfileAvatarSeed}
          onClose={() => setDialogTab(null)}
          onUpdateProfile={onUpdateCloudProfile}
          onSignOut={onCloudSignOut}
        />
      ) : null}

      {cloudSettings
        && cloudAccount
        && isProfileCardOpen
        && popoverAnchor
        && typeof document !== 'undefined'
        ? createPortal(
          <div
            ref={profilePopoverRef}
            role="dialog"
            aria-label="Account menu"
            style={{
              position: 'fixed',
              left: popoverAnchor.left,
              bottom: popoverAnchor.bottom,
              zIndex: 170,
            }}
            className={cn(
              'app-transient-surface app-popover app-profile-popover',
              'w-[22rem] rounded-[18px] border px-4 py-3 text-foreground',
            )}
          >
            <div className="mb-3 flex items-start gap-3">
              <IdentityAvatar
                kind="human"
                seed={profileAvatarSeed}
                name={profileDisplayName}
                imageUrl={profileImageUrl}
                className="h-10 w-10 border border-white/10"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold">{profileDisplayName}</div>
                <div className="app-transient-muted mt-0.5 flex min-w-0 items-center gap-2 text-[11px]">
                  <span className="shrink-0">Account</span>
                  <span aria-hidden="true" className="app-transient-subtle">•</span>
                  <span
                    className="min-w-0 truncate font-mono"
                    title={cloudAccount.accountId}
                  >
                    {cloudAccount.accountId}
                  </span>
                  <CloudProfileRowCopyButton
                    label="Account ID"
                    value={cloudAccount.accountId}
                  />
                </div>
              </div>
            </div>
            {cloudAccount.primaryEmail?.trim() ? (
              <div className="grid gap-1 text-[12px]">
                <div className="app-transient-row flex min-w-0 items-center gap-3 rounded-[12px] px-3 py-2.5 transition">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">Email</div>
                    <div className="app-transient-muted mt-0.5 truncate text-[11px]">
                      {cloudAccount.primaryEmail.trim()}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            <div className="app-transient-divider mt-3 grid gap-1 border-t pt-3">
              <button
                type="button"
                className="app-transient-row app-list-item flex items-center justify-between rounded-[12px] px-3 py-2.5 text-left text-[12px] font-medium transition"
                onClick={() => openCloudAccountDialog('auth')}
                aria-label="Open account settings"
              >
                <span className="flex items-center gap-2.5">
                  <Settings className="app-transient-muted h-4 w-4" />
                  Settings
                </span>
                <ChevronRightIcon className="app-transient-subtle h-4 w-4" />
              </button>
            </div>
          </div>,
          document.querySelector('.kordi-app') ?? document.body,
        )
        : null}

      {!cloudSettings
        && isProfileCardOpen
        && popoverAnchor
        && typeof document !== 'undefined'
        ? createPortal(
          <div
            ref={profilePopoverRef}
            role="dialog"
            aria-label="Profile"
            style={{
              position: 'fixed',
              left: popoverAnchor.left,
              bottom: popoverAnchor.bottom,
              zIndex: 160,
            }}
            className={cn(
              'app-transient-surface app-popover app-profile-popover',
              'w-[21.25rem] rounded-[18px] border px-4 py-3 text-foreground',
            )}
          >
            <div className="mb-3 flex items-center justify-between gap-3 text-[12px] font-medium">
              <span>Profile</span>
            </div>
            <div className="grid gap-1 text-[12px]">
              <div className="app-transient-row rounded-[12px] px-3 py-2.5 transition">
                <div className="truncate font-medium">{profileDisplayName}</div>
                <div className="app-transient-muted mt-0.5 truncate text-[11px]">
                  {cloudAccount ? 'Account' : 'Local profile'}
                </div>
              </div>
              {profileRows.length > 0 ? profileRows.map((row) => (
                <div
                  key={row.label}
                  className="app-transient-row flex min-w-0 items-center gap-3 rounded-[12px] px-3 py-2.5 transition"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{row.label}</div>
                    <div className="app-transient-muted mt-0.5 truncate text-[11px]">
                      {row.value}
                    </div>
                  </div>
                  {row.copyable ? (
                    <CloudProfileRowCopyButton label={row.label} value={row.value} />
                  ) : null}
                </div>
              )) : (
                <div className="app-transient-muted rounded-[12px] px-3 py-2.5 text-[12px]">
                  Profile details are stored locally.
                </div>
              )}
            </div>
          </div>,
          document.querySelector('.kordi-app') ?? document.body,
        )
        : null}
    </>
  );
}

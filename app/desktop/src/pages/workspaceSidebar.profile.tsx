import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight as ChevronRightIcon, Copy, Settings, Share2, X } from 'lucide-react';

import { cloudAvatarImageUrl } from '@/features/cloud/avatar';
import { canonicalAvatarImageSource } from '@/features/cloud/canonicalAvatar';
import { formatKordiHandle } from '@/features/cloud/kordiId';
import { memoryClientForEnvironment, memorySectionAvailable } from '@/features/memory/memoryClient';
import { OrganizationJoinHost } from '@/features/organizations/OrganizationJoinHost';
import { OrganizationMenuLevels } from '@/features/organizations/OrganizationSwitcher';
import { openOrganizationJoinDialog } from '@/features/organizations/organizationJoinPrompt';
import { useAccountOrganizations } from '@/features/organizations/useOrganizations';
import { IdentityAvatar, useLocalProfileAvatarSeed } from '@/kordi-app/components/IdentityAvatar';
import { cn } from '@/lib/utils';
import {
  CloudAccountSettingsDialog,
  type CloudAccountSettingsTabId,
} from '@/pages/CloudAccountSettingsDialog';
import type { WorkspaceSidebarAccount } from '@/pages/workspaceSidebar.types';
import {
  accountPopoverLeft,
  buildCloudProfileRows,
} from '@/pages/workspaceSidebar.profileModel';

const CLOUD_PROFILE_COPY_RESET_MS = 1800;

export function CloudProfileRowCopyButton({
  label,
  value,
  compact = false,
}: {
  label: string;
  value: string;
  compact?: boolean;
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
        'shrink-0 inline-flex items-center justify-center gap-1 rounded-[8px] text-[11px] font-semibold transition',
        compact ? 'h-7 w-7' : 'px-2 py-1',
        copied
          ? 'bg-emerald-500/15 text-emerald-200'
          : errored
            ? 'bg-red-500/15 text-red-200'
            : 'app-button-quiet app-transient-flat-action',
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
      {compact ? (
        copied
          ? <Check className="h-3.5 w-3.5" aria-hidden="true" />
          : <Copy className="h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <>
          {copied ? <Check className="h-3 w-3" aria-hidden="true" /> : null}
          {copied ? 'Copied' : errored ? 'Copy failed' : 'Copy'}
        </>
      )}
    </button>
  );
}

function CloudAppInviteCopyRow({ onCreateInvite }: { onCreateInvite: () => Promise<string> }) {
  const [status, setStatus] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle');
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
    if (status === 'copying') return;
    setStatus('copying');
    try {
      const inviteUrl = await onCreateInvite();
      if (!inviteUrl.trim() || typeof navigator === 'undefined' || !navigator.clipboard) {
        throw new Error('Clipboard unavailable');
      }
      await navigator.clipboard.writeText(inviteUrl);
      setStatus('copied');
    } catch {
      setStatus('error');
    } finally {
      scheduleReset();
    }
  };

  // One dense row, like the Help menu: the status takes the label's place while it applies.
  const label = status === 'copying'
    ? 'Creating invitation…'
    : status === 'copied'
      ? 'Invitation link copied'
      : status === 'error'
        ? 'Could not copy link'
        : 'Invite to Kordi';

  return (
    <button
      type="button"
      className="app-dense-menu-row disabled:cursor-wait"
      onClick={() => { void handleCopy(); }}
      disabled={status === 'copying'}
      aria-label="Copy personal invitation link"
    >
      <Share2 aria-hidden="true" />
      <span className="truncate" aria-live="polite">{label}</span>
      {status === 'copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
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
  cloudMemoryVersion,
  onUpdateCloudProfile,
  onRequestCloudEmailCode,
  onVerifyCloudEmail,
  onCloudEmailAlreadyVerified,
  onCloudSignOut,
  onCreateAppInvite,
}: WorkspaceSidebarAccount) {
  const [isProfileCardOpen, setIsProfileCardOpen] = useState(false);
  const [localDialogTab, setLocalDialogTab] = useState<CloudAccountSettingsTabId | null>(null);
  const [deviceReview, setDeviceReview] = useState<{ accountId: string; needsReview: boolean } | null>(null);
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
  const accountOrganizations = useAccountOrganizations(cloudAccount?.accountId, isProfileCardOpen);
  const profileRows = buildCloudProfileRows(cloudAccount);
  const profileDisplayName = cloudAccount
    ? cloudAccount.displayName?.trim() || 'Kordi user'
    : 'Local profile';
  const profileKordiHandle = formatKordiHandle(cloudAccount?.kordiId);
  const profileAvatarSeed = cloudAccount
    ? cloudAccount.avatar.seed
    : localProfileAvatarSeed || currentLocalProfileAvatarSeed;
  const profileImageUrl = cloudAccount
    ? cloudAvatarImageUrl(canonicalAvatarImageSource(cloudAccount.avatar))
    : null;
  const hasDeviceReview = Boolean(
    cloudAccount
    && deviceReview?.accountId === cloudAccount.accountId
    && deviceReview.needsReview,
  );

  useLayoutEffect(() => {
    if (!isProfileCardOpen) return;
    const trigger = profileTriggerRef.current;
    if (!trigger) return;
    const measure = () => {
      const rect = trigger.getBoundingClientRect();
      const rootFontSize = Number.parseFloat(
        window.getComputedStyle(document.documentElement).fontSize,
      ) || 16;
      setPopoverAnchor({
        left: accountPopoverLeft({
          triggerRight: rect.right,
          viewportWidth: window.innerWidth,
          rootFontSize,
        }),
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

  useEffect(() => {
    if (typeof window === 'undefined' || !cloudAccount?.accountId) return;
    const handleNewDevice = (event: Event) => {
      const accountId = (event as CustomEvent<{ accountId?: string }>).detail?.accountId;
      if (accountId === cloudAccount.accountId) {
        setDeviceReview({ accountId, needsReview: true });
      }
    };
    window.addEventListener('kordi-cloud-new-device', handleNewDevice);
    return () => window.removeEventListener('kordi-cloud-new-device', handleNewDevice);
  }, [cloudAccount?.accountId]);

  const openCloudAccountDialog = (tab: CloudAccountSettingsTabId) => {
    setIsProfileCardOpen(false);
    if (tab === 'devices' && cloudAccount) {
      setDeviceReview({ accountId: cloudAccount.accountId, needsReview: false });
    }
    setDialogTab(tab);
  };

  return (
    <>
      <button
        ref={profileTriggerRef}
        type="button"
        className="app-nav-rail-profile rounded-full"
        onClick={() => setIsProfileCardOpen((open) => !open)}
        data-help-target="profile"
        aria-label="Open profile"
        aria-expanded={isProfileCardOpen}
      >
        <IdentityAvatar
          kind="human"
          seed={profileAvatarSeed}
          isSelf
          name={profileDisplayName}
          imageUrl={profileImageUrl}
          className="app-nav-rail-avatar h-7 w-7"
        />
        {hasDeviceReview ? (
          <span
            className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-[color:var(--app-session-bg)] bg-amber-400"
            aria-label="A new device needs review"
            role="status"
          />
        ) : null}
      </button>

      <OrganizationJoinHost accountId={cloudAccount?.accountId} />
      {cloudSettings && cloudAccount && onUpdateCloudProfile ? (
        <CloudAccountSettingsDialog
          {...cloudSettings}
          isOpen={dialogTab !== null}
          initialTab={dialogTab ?? 'profile'}
          account={cloudAccount}
          onClose={() => setDialogTab(null)}
          onUpdateProfile={onUpdateCloudProfile}
          onRequestEmailCode={onRequestCloudEmailCode}
          onVerifyEmail={onVerifyCloudEmail}
          onEmailAlreadyVerified={onCloudEmailAlreadyVerified}
          onSignOut={onCloudSignOut}
          memoryClient={memorySectionAvailable(cloudMemoryVersion) ? memoryClientForEnvironment() : null}
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
            className="app-transient-surface app-dense-menu app-account-popover"
          >
            <OrganizationMenuLevels
              {...accountOrganizations}
              onFind={() => {
                setIsProfileCardOpen(false);
                openOrganizationJoinDialog();
              }}
              onClose={() => setIsProfileCardOpen(false)}
            >
              {(organizationEntry) => (
                <>
                <div className="app-dense-menu-header app-account-identity">
                  <IdentityAvatar
                    kind="human"
                    seed={profileAvatarSeed}
                    isSelf
                    name={profileDisplayName}
                    imageUrl={profileImageUrl}
                    className="h-8 w-8"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="app-account-identity-name truncate">{profileDisplayName}</div>
                    <div className="app-dense-menu-meta truncate">
                      {profileKordiHandle || 'Kordi ID unavailable'}
                    </div>
                  </div>
                  {profileKordiHandle ? (
                    <CloudProfileRowCopyButton
                      label="Kordi ID"
                      value={profileKordiHandle}
                      compact
                    />
                  ) : null}
                </div>
                {organizationEntry}
                <div className="app-dense-menu-divider" />
                <div className="app-dense-menu-items">
                  {onCreateAppInvite ? (
                    <CloudAppInviteCopyRow onCreateInvite={onCreateAppInvite} />
                  ) : null}
                  <button
                    type="button"
                    className="app-dense-menu-row"
                    onClick={() => openCloudAccountDialog(hasDeviceReview ? 'devices' : 'profile')}
                    aria-label={hasDeviceReview ? 'Open settings to review a new device' : 'Open account settings'}
                  >
                    <Settings aria-hidden="true" />
                    <span>Settings</span>
                    {hasDeviceReview ? (
                      <span className="app-dense-menu-meta rounded-full bg-amber-400/10 px-2 py-0.5 text-[10px] text-amber-200">
                        Review
                      </span>
                    ) : null}
                    <ChevronRightIcon aria-hidden="true" />
                  </button>
                </div>
                </>
              )}
            </OrganizationMenuLevels>
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
            className="app-transient-surface app-dense-menu app-account-popover"
          >
            <header className="app-dense-menu-header">
              <h2>Profile</h2>
              <button type="button" onClick={() => setIsProfileCardOpen(false)} aria-label="Close profile">
                <X aria-hidden="true" />
              </button>
            </header>
            <div className="app-dense-menu-items">
              <div className="app-dense-menu-info">
                <div className="truncate">{profileDisplayName}</div>
                <div className="app-dense-menu-meta truncate">
                  {cloudAccount ? 'Account' : 'Local profile'}
                </div>
              </div>
              {profileRows.length > 0 ? profileRows.map((row) => (
                <div key={row.label} className="app-dense-menu-info flex min-w-0 items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{row.label}</div>
                    <div className="app-dense-menu-meta truncate">{row.value}</div>
                  </div>
                  {row.copyable ? (
                    <CloudProfileRowCopyButton label={row.label} value={row.value} />
                  ) : null}
                </div>
              )) : (
                <div className="app-dense-menu-info app-dense-menu-meta">
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

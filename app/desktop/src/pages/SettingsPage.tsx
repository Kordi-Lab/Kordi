import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AuthPage } from '@/kordi-app/auth/AuthPage';
import { SettingsNav, SettingsRow, SettingsSection, SettingsValueControl } from '@/kordi-app/components';
import { EditableIdentityAvatar } from '@/kordi-app/components/EditableIdentityAvatar';
import { useLocalProfileAvatarSeed } from '@/kordi-app/components/IdentityAvatar';
import type { SettingsSection as SettingsSectionData } from '@/kordi-app/data/settings';
import type {
  DesktopAuthState,
  ThemeMode,
} from '@/kordi-app/types';
import { cn } from '@/lib/utils';
import type { DesktopChatMessageRoute } from '@/lib/desktop';
import { NotificationSettingsPanel } from '@/features/notifications/NotificationSettingsPanel';

type SettingsPageProps = {
  settingsRailWidth: number;
  settingsContentRef: MutableRefObject<HTMLDivElement | null>;
  activeSettingsSectionId: SettingsSectionData['id'];
  setActiveSettingsSectionId: Dispatch<SetStateAction<SettingsSectionData['id']>>;
  settingsSections: SettingsSectionData[];
  activeSettingsSection: SettingsSectionData;
  authSettingsLayoutWidth: number;
  isNativeShell: boolean;
  localProfileAvatarSeed?: string | null;
  desktopAuthState: DesktopAuthState | null;
  isDesktopAuthLoading: boolean;
  desktopAuthError: string | null;
  activeLoginProviderId: string | null;
  selectAuthProvider: (providerId: string) => void;
  openLoginFlow: (provider: any, mode: 'oauth' | 'api-key', options?: { authority?: string; requireAuthority?: boolean }) => void;
  refreshDesktopAuth: () => Promise<void>;
  handleSelectAuthChoice: (providerId: string, choice: string) => Promise<void>;
  handleRemoveAuthProfile: (providerId: string, profileId: string) => Promise<void>;
  handleLogoutProvider: (providerId: string) => Promise<void>;
  onEnterChat?: (preferredModelValue?: string, route?: DesktopChatMessageRoute) => void | Promise<void>;
  themeMode: ThemeMode;
  setThemeMode: Dispatch<SetStateAction<ThemeMode>>;
};

export function SettingsPage({
  settingsRailWidth,
  settingsContentRef,
  activeSettingsSectionId,
  setActiveSettingsSectionId,
  settingsSections,
  activeSettingsSection,
  authSettingsLayoutWidth,
  isNativeShell,
  localProfileAvatarSeed,
  desktopAuthState,
  isDesktopAuthLoading,
  desktopAuthError,
  activeLoginProviderId,
  selectAuthProvider,
  openLoginFlow,
  refreshDesktopAuth,
  handleSelectAuthChoice,
  handleRemoveAuthProfile,
  handleLogoutProvider,
  onEnterChat,
  themeMode,
  setThemeMode,
}: SettingsPageProps) {
  const currentLocalProfileAvatarSeed = useLocalProfileAvatarSeed();
  return (
    <div className="app-settings-page h-full" style={{ WebkitAppRegion: 'no-drag' as const }}>
      <div
        className="app-main-panel grid h-full w-full gap-0 overflow-hidden text-white"
        style={{ gridTemplateColumns: `${settingsRailWidth}px minmax(0, 1fr)`, WebkitAppRegion: 'no-drag' as const }}
      >
        <div className="app-session-panel overflow-y-auto p-3 shadow-[inset_-1px_0_0_var(--app-divider)]">
          <SettingsNav
            groups={[{
              label: 'Settings',
              items: settingsSections.map((section) => ({ id: section.id, label: section.label, icon: section.icon })),
            }]}
            activeId={activeSettingsSectionId}
            onSelect={setActiveSettingsSectionId}
          />
        </div>
        <ScrollArea className={cn(
          'app-main-panel relative z-10 block h-full w-full min-w-0 justify-self-stretch overflow-x-hidden pointer-events-auto',
          activeSettingsSection.id === 'auth' && 'overflow-hidden',
        )}>
          <div
            ref={settingsContentRef}
            className={cn(
              'block w-full min-w-0 max-w-none px-8 py-8',
              activeSettingsSection.id === 'auth' && 'h-full min-h-0',
            )}
            style={{ width: '100%', maxWidth: '100%', WebkitAppRegion: 'no-drag' as const }}
          >
            {activeSettingsSection.id === 'auth' ? (
              <AuthPage
                variant="settings"
                layoutWidth={authSettingsLayoutWidth}
                isNativeShell={isNativeShell}
                authState={desktopAuthState}
                isLoading={isDesktopAuthLoading}
                error={desktopAuthError}
                selectedProviderId={activeLoginProviderId}
                onSelectProvider={selectAuthProvider}
                onOpenLogin={openLoginFlow}
                onRefresh={() => {
                  void refreshDesktopAuth();
                }}
                onSelectAuthChoice={(providerId, choice) => {
                  void handleSelectAuthChoice(providerId, choice);
                }}
                onRemoveAuthProfile={(providerId, profileId) => {
                  void handleRemoveAuthProfile(providerId, profileId);
                }}
                onLogoutProvider={(providerId) => {
                  void handleLogoutProvider(providerId);
                }}
                onEnterChat={onEnterChat}
              />
            ) : activeSettingsSection.id === 'notifications' ? (
              <NotificationSettingsPanel isNativeShell={isNativeShell} />
            ) : (
              <div className="app-settings-option-list max-w-[680px]">
                <SettingsSection title={activeSettingsSection.title}>
                  {activeSettingsSection.id === 'personalization' ? (
                    <SettingsRow
                      className="app-settings-profile-section"
                      title="Profile avatar"
                      description="Shown next to your messages on this Mac."
                      control={(
                        <EditableIdentityAvatar
                          kind="human"
                          seed={localProfileAvatarSeed || currentLocalProfileAvatarSeed}
                          isSelf
                          name="Local profile"
                          label="Local profile"
                          className="h-12 w-12 border border-white/10"
                        />
                      )}
                    />
                  ) : null}
                  {activeSettingsSection.items.map((item) => (
                    <SettingsRow
                      key={item.label}
                      className="app-settings-option-row"
                      title={item.label}
                      description={item.hint}
                      control={<SettingsValueControl item={item} themeMode={themeMode} onSelectThemeMode={setThemeMode} />}
                    />
                  ))}
                </SettingsSection>
              </div>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AuthPage } from '@/kordi-app/auth/AuthPage';
import { SettingsValueControl } from '@/kordi-app/components';
import { EditableIdentityAvatar } from '@/kordi-app/components/EditableIdentityAvatar';
import { useLocalProfileAvatarSeed } from '@/kordi-app/components/IdentityAvatar';
import type { SettingsSection } from '@/kordi-app/data/settings';
import type {
  DesktopAuthState,
  ThemeMode,
} from '@/kordi-app/types';
import { cn } from '@/lib/utils';

type SettingsPageProps = {
  settingsRailWidth: number;
  settingsContentRef: MutableRefObject<HTMLDivElement | null>;
  activeSettingsSectionId: SettingsSection['id'];
  setActiveSettingsSectionId: Dispatch<SetStateAction<SettingsSection['id']>>;
  settingsSections: SettingsSection[];
  activeSettingsSection: SettingsSection;
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
  onEnterChat?: (preferredModelValue?: string) => void | Promise<void>;
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
        <div className="app-session-panel p-2.5 shadow-[inset_-1px_0_0_var(--app-divider)]">
          <div className="space-y-1">
            {settingsSections.map((section) => {
              const Icon = section.icon;
              const active = activeSettingsSectionId === section.id;
              return (
                <button
                  key={section.id}
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => setActiveSettingsSectionId(section.id)}
                  className={cn(
                    'app-settings-nav-item flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-slate-300',
                    active && 'app-settings-nav-item-active text-white',
                  )}
                >
                  <div className="grid h-7 w-7 place-items-center">
                    <Icon className={cn('h-3.5 w-3.5', active ? 'text-white' : 'text-slate-400')} />
                  </div>
                  <div className="text-[13px] font-medium leading-5">{section.label}</div>
                </button>
              );
            })}
          </div>
        </div>
        <ScrollArea className={cn(
          'app-main-panel relative z-10 block h-full w-full min-w-0 justify-self-stretch overflow-x-hidden pointer-events-auto',
          activeSettingsSection.id === 'auth' && 'overflow-hidden',
        )}>
          <div
            ref={settingsContentRef}
            className={cn(
              'block w-full min-w-0 max-w-none px-6 py-5',
              activeSettingsSection.id === 'auth' && 'h-full min-h-0',
            )}
            style={{ width: '100%', maxWidth: '100%', WebkitAppRegion: 'no-drag' as const }}
          >
            {activeSettingsSection.id !== 'auth' && (
              <div className="mb-5">
                <div className="text-[18px] font-semibold tracking-tight text-white">{activeSettingsSection.title}</div>
              </div>
            )}
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
            ) : activeSettingsSection.id === 'personalization' ? (
              <div className="space-y-5">
                <div className="app-settings-profile-section px-1 py-3">
                  <div className="mb-3.5 flex items-start justify-between gap-3">
                    <div>
                      <div className="text-[15px] font-medium text-white">Profile avatar</div>
                    </div>
                  </div>
                  <EditableIdentityAvatar
                    kind="human"
                    seed={localProfileAvatarSeed || currentLocalProfileAvatarSeed}
                    isSelf
                    name="Local profile"
                    label="Local profile"
                    className="h-16 w-16 border border-white/10"
                  />
                </div>

                <div className="app-settings-option-list">
                  {activeSettingsSection.items.map((item) => (
                    <div
                      key={item.label}
                      className="app-settings-option-row grid items-center gap-3 px-1 py-3.5 md:grid-cols-[minmax(0,1fr)_minmax(208px,280px)]"
                    >
                      <div>
                        <div className="text-[13px] font-medium text-white">{item.label}</div>
                        {item.hint ? <div className="mt-1 text-[12px] leading-5 text-slate-400">{item.hint}</div> : null}
                      </div>
                      <div className="flex justify-end">
                        <SettingsValueControl item={item} themeMode={themeMode} onSelectThemeMode={setThemeMode} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="app-settings-option-list">
                {activeSettingsSection.items.map((item) => (
                  <div
                    key={item.label}
                    className="app-settings-option-row grid items-center gap-3 px-1 py-3.5 md:grid-cols-[minmax(0,1fr)_minmax(208px,280px)]"
                  >
                    <div>
                      <div className="text-[13px] font-medium text-white">{item.label}</div>
                      {item.hint ? <div className="mt-1 text-[12px] leading-5 text-slate-400">{item.hint}</div> : null}
                    </div>
                    <div className="flex justify-end">
                      <SettingsValueControl item={item} themeMode={themeMode} onSelectThemeMode={setThemeMode} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

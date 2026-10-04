import { useId } from 'react';

import { SettingsRow, SettingsSection, SettingsSelect } from '@/kordi-app/components/settingsLayout';
import {
  parseLinkPreviewPreference,
  setLinkPreviewPreference,
  useLinkPreviewPreference,
  type LinkPreviewPreference,
} from './linkPreviewPolicy';

const LINK_PREVIEW_OPTIONS: Array<{ value: LinkPreviewPreference; label: string }> = [
  { value: 'contacts', label: 'From contacts' },
  { value: 'everyone', label: 'Everyone' },
  { value: 'off', label: 'Off' },
];

const LINK_PREVIEW_DESCRIPTIONS: Record<LinkPreviewPreference, string> = {
  contacts: 'Kordi loads previews and site icons only for links you send and links from people in your contacts. Other links show just the web address.',
  everyone: 'Kordi loads previews and site icons for every link, including links from agents and from people who aren\'t in your contacts.',
  off: 'Kordi doesn\'t load link previews or site icons. Links show just the web address.',
};

const LINK_PREVIEW_CONNECTION_NOTE = 'Loading a preview connects this Mac to the linked website, which can see your IP address and when the link was viewed.';

const LOCAL_MESSAGES_NOTE = 'Kordi keeps copies of recent messages and downloaded files on this Mac so they open quickly. They\'re stored so other accounts on this Mac can\'t open them without administrator access. Kordi doesn\'t add its own encryption to these copies. Turn on FileVault in System Settings to protect them when your Mac is shut down.';

export function PrivacySettingsPanel({ isNativeShell }: { isNativeShell: boolean }) {
  const linkPreviewPreference = useLinkPreviewPreference();
  const descriptionId = useId();

  return (
    <>
      <SettingsSection title="Privacy">
        <SettingsRow
          title="Link previews"
          description={(
            <span id={descriptionId} aria-live="polite">
              {`${LINK_PREVIEW_DESCRIPTIONS[linkPreviewPreference]} ${LINK_PREVIEW_CONNECTION_NOTE}`}
            </span>
          )}
          control={(
            <SettingsSelect
              label="Link previews"
              aria-describedby={descriptionId}
              value={linkPreviewPreference}
              options={LINK_PREVIEW_OPTIONS}
              onChange={(event) => setLinkPreviewPreference(parseLinkPreviewPreference(event.currentTarget.value))}
            />
          )}
        />
      </SettingsSection>
      {isNativeShell ? (
        <SettingsSection title="Messages on this Mac">
          <p className="app-settings-row m-0 py-3.5 text-[12px] leading-5 text-slate-400">{LOCAL_MESSAGES_NOTE}</p>
        </SettingsSection>
      ) : null}
    </>
  );
}

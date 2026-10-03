import { setMessageLayout, useMessageLayout, type MessageLayout } from '@/app/messageLayoutPreference';
import { SettingsRow } from './settingsLayout';

export function MessageLayoutSetting() {
  const layout = useMessageLayout();
  return (
    <SettingsRow
      className="app-settings-option-row"
      title="Message layout"
      description="Chat uses bubbles. Threads uses a compact, continuous list."
      control={(
        <div className="app-message-layout-options" role="group" aria-label="Message layout">
          {(['chat', 'threads'] as const).map((value: MessageLayout) => (
            <button key={value} type="button" aria-pressed={layout === value}
              className="app-button-quiet" onClick={() => setMessageLayout(value)}>
              {value === 'chat' ? 'Chat' : 'Threads'}
            </button>
          ))}
        </div>
      )}
    />
  );
}

// Preview pages start in Classic, like the app (src/main.jsx applies the stored theme, Classic by default).
// ?chatTheme=classic|quiet|midnight|sand|ocean picks another one. Pages that set their own theme do not import this.
import { applyChatTheme, isChatTheme, type ChatTheme } from '../../src/app/themePreference';

export function previewChatTheme(search: string = location.search): ChatTheme {
  const requested = new URLSearchParams(search).get('chatTheme');
  return isChatTheme(requested) ? requested : 'classic';
}

applyChatTheme(previewChatTheme());

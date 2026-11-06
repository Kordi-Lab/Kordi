import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from '@/App.jsx';
import { applyChatTheme, readStoredChatTheme } from '@/app/themePreference';
import { preloadNotoEmojiThumbnails } from '@/features/emoji/notoEmojiThumbnails';
import './index.css';

applyChatTheme(readStoredChatTheme());
void preloadNotoEmojiThumbnails();
const element = document.getElementById('root');
if (!element) throw new Error('The Kordi application root is missing.');
createRoot(element).render(<StrictMode><App /></StrictMode>);

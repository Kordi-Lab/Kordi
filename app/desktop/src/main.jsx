import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { applyChatTheme, readStoredChatTheme } from './app/themePreference'
import { preloadNotoEmojiThumbnails } from './features/emoji/notoEmojiThumbnails'

applyChatTheme(readStoredChatTheme())
void preloadNotoEmojiThumbnails()
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

if (import.meta.env.VITE_KORDI_TRANSCRIPT_TRACE === '1') {
  void import('./features/performance/transcriptTrajectory').then(({ installTranscriptTrajectoryRecorder }) => installTranscriptTrajectoryRecorder())
}

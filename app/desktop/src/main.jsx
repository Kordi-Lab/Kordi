import { StrictMode, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { applyChatTheme, readStoredChatTheme } from './app/themePreference'
import { preloadNotoEmojiThumbnails } from './features/emoji/notoEmojiThumbnails'

applyChatTheme(readStoredChatTheme())
const root = createRoot(document.getElementById('root'))
const authPreview = import.meta.env.DEV
  ? new URLSearchParams(window.location.search).get('authPreview')
  : null

if (authPreview === 'start' || authPreview === 'settings' || authPreview === 'login') {
  void import('./dev/AuthPreview.tsx').then(({ AuthPreview }) => {
    root.render(<StrictMode>{createElement(AuthPreview, { variant: authPreview })}</StrictMode>)
  })
} else {
  void preloadNotoEmojiThumbnails()
  root.render(<StrictMode><App /></StrictMode>)
}

if (import.meta.env.VITE_KORDI_TRANSCRIPT_TRACE === '1') {
  void import('./features/performance/transcriptTrajectory').then(({ installTranscriptTrajectoryRecorder }) => installTranscriptTrajectoryRecorder())
}

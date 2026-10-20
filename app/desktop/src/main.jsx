import { StrictMode, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { applyChatTheme, readStoredChatTheme } from './app/themePreference'
import { DEFAULT_APP_ICON, applyAppIcon, readStoredAppIcon } from './app/appIconPreference'
import { preloadNotoEmojiThumbnails } from './features/emoji/notoEmojiThumbnails'

applyChatTheme(readStoredChatTheme())
const appIcon = readStoredAppIcon()
if (appIcon !== DEFAULT_APP_ICON) applyAppIcon(appIcon)
const root = createRoot(document.getElementById('root'))
const authPreview = new URLSearchParams(window.location.search).get('authPreview')

// The literal DEV check lets production builds drop the preview and its chunk.
if (import.meta.env.DEV && (authPreview === 'start' || authPreview === 'settings' || authPreview === 'login')) {
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

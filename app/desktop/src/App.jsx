import { useEffect } from 'react'
import KordiApp from './KordiApp.tsx'
import AuthPopup from './AuthPopup.tsx'
import AttachmentMediaWindow from './AttachmentMediaWindow.tsx'
import CallWindow from './CallWindow.tsx'

function isNativeDesktopShell() {
  if (typeof window === 'undefined') return false
  return typeof window.__TAURI_INTERNALS__ !== 'undefined'
}

function App() {
  const isNativeShell = isNativeDesktopShell()

  useEffect(() => {
    document.documentElement.classList.toggle('kordi-native-shell', isNativeShell)
    document.body.classList.toggle('kordi-native-shell', isNativeShell)
    return () => {
      document.documentElement.classList.remove('kordi-native-shell')
      document.body.classList.remove('kordi-native-shell')
    }
  }, [isNativeShell])

  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search)
    if (params.get('authPopup') === '1') {
      return <AuthPopup />
    }
    if (params.get('mediaPreview') === '1') {
      return <AttachmentMediaWindow />
    }
    if (params.get('callWindow') === '1') {
      return <CallWindow />
    }
  }

  return <KordiApp />
}

export default App

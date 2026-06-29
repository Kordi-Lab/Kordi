import { useEffect } from 'react'
import KordiApp from './KordiApp.tsx'
import AuthPopup from './AuthPopup.tsx'

function isNativeDesktopShell() {
  if (typeof window === 'undefined') return false
  return typeof window.__TAURI_INTERNALS__ !== 'undefined'
}

function App() {
  const isNativeShell = isNativeDesktopShell()

  useEffect(() => {
    document.body.classList.toggle('kordi-native-shell', isNativeShell)
    return () => document.body.classList.remove('kordi-native-shell')
  }, [isNativeShell])

  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search)
    if (params.get('authPopup') === '1') {
      return <AuthPopup />
    }
  }

  return <KordiApp />
}

export default App

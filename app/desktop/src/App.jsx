import { useEffect } from 'react'
import KordiApp from './KordiApp.tsx'
import AuthPopup from './AuthPopup.tsx'
import {
  installNativeLiveResizeBridge,
  resetNativeLiveResizeState,
} from './app/nativeLiveResize.ts'

function isNativeDesktopShell() {
  if (typeof window === 'undefined') return false
  return typeof window.__TAURI_INTERNALS__ !== 'undefined'
}

function App() {
  const isNativeShell = isNativeDesktopShell()

  useEffect(() => {
    let disposed = false
    let uninstallLiveResizeBridge
    document.documentElement.classList.toggle('kordi-native-shell', isNativeShell)
    document.body.classList.toggle('kordi-native-shell', isNativeShell)
    if (isNativeShell) {
      void installNativeLiveResizeBridge()
        .then((uninstall) => {
          if (disposed) uninstall()
          else uninstallLiveResizeBridge = uninstall
        })
        .catch(() => undefined)
    }
    return () => {
      disposed = true
      uninstallLiveResizeBridge?.()
      resetNativeLiveResizeState()
      document.documentElement.classList.remove('kordi-native-shell')
      document.body.classList.remove('kordi-native-shell')
    }
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

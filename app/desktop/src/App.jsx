import KordiApp from './KordiApp.tsx'
import AuthPopup from './AuthPopup.tsx'

function App() {
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search)
    if (params.get('authPopup') === '1') {
      return <AuthPopup />
    }
  }

  return <KordiApp />
}

export default App

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { applyChatTheme, readStoredChatTheme } from './app/themePreference'

applyChatTheme(readStoredChatTheme())
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

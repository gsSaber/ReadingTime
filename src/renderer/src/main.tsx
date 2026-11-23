import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ExternalTranslation } from './components/ExternalTranslation'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {location.hash === '#external-selection' ? <ExternalTranslation /> : <App />}
  </StrictMode>
)

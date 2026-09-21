import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// 老内核 WebView（Android TV 系统 WebView 66 等）API 补丁，必须最先执行
import './polyfills/legacy'
import './assets/global.css'
import RootLayout from './Layout'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { initializeLogger } from './lib/logger'

initializeLogger()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <RootLayout>
        <App />
      </RootLayout>
    </ErrorBoundary>
  </StrictMode>,
)

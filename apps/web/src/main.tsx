import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { accessToken, completeLogin, login, oidcEnabled } from './auth.ts'
import './styles.css'

const root = createRoot(document.getElementById('root')!)
const render = () =>
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )

if (!oidcEnabled) render()
else
  completeLogin()
    .then(() => (accessToken() ? render() : login()))
    .catch((error: unknown) =>
      root.render(<p role="alert">{error instanceof Error ? error.message : '登录失败'}</p>),
    )

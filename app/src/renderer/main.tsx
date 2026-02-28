import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { SessionWindow } from './SessionWindow';

function applyTheme(payload: {
  themeMode?: 'system' | 'light' | 'dark' | 'user-css';
  effectiveTheme?: 'light' | 'dark';
  userCss?: string;
}) {
  const mode = payload.themeMode ?? 'system';
  const effective = payload.effectiveTheme === 'light' ? 'light' : 'dark';
  const baseTheme = mode === 'light' ? 'light' : mode === 'dark' ? 'dark' : effective;
  document.documentElement.setAttribute('data-theme', baseTheme);

  const styleId = 'truss-user-css';
  const existing = document.getElementById(styleId);
  if (mode !== 'user-css') {
    existing?.remove();
    return;
  }

  const css = payload.userCss ?? '';
  const styleEl = existing instanceof HTMLStyleElement ? existing : document.createElement('style');
  styleEl.id = styleId;
  styleEl.textContent = css;
  if (!existing) {
    document.head.appendChild(styleEl);
  }
}

const electronAPI = (window as any).electronAPI;
electronAPI?.getPreferences?.().then((prefs: {
  themeMode?: 'system' | 'light' | 'dark' | 'user-css';
  effectiveTheme?: 'light' | 'dark';
  userCss?: string;
}) => {
  applyTheme(prefs || {});
});
electronAPI?.onThemeUpdated?.((payload: {
  themeMode?: 'system' | 'light' | 'dark' | 'user-css';
  effectiveTheme?: 'light' | 'dark';
  userCss?: string;
}) => {
  applyTheme(payload || {});
});

const params = new URLSearchParams(window.location.search);
const session = params.get('session');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {session ? <SessionWindow /> : <App />}
  </React.StrictMode>,
);

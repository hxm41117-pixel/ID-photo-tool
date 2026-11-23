import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

// Auto-reload once if browser has a stale HTML referencing an outdated chunk hash after deployment
window.addEventListener('vite:preloadError', () => {
  const reloadKey = 'id_photo_chunk_reload_ts';
  const lastReload = Number(sessionStorage.getItem(reloadKey) || '0');
  if (Date.now() - lastReload > 10000) {
    sessionStorage.setItem(reloadKey, String(Date.now()));
    window.location.reload();
  }
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

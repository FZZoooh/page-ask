import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'katex/dist/katex.min.css';
import App from './App';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { applyTheme, cachedThemePreference, resolveTheme } from '@/lib/theme';
import './style.css';

// Restore the theme before the first paint: storage.local is async, so this reads the
// localStorage mirror that App writes on every settings load/save ('auto' re-resolves the
// OS scheme synchronously via matchMedia).
applyTheme(resolveTheme(cachedThemePreference()));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

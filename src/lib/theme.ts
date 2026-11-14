/**
 * Theme resolution: settings.theme picks the palette, 'auto' follows the OS via matchMedia.
 * The resolved value lands on <html data-theme> — the same mechanism as data-font-size — and
 * style.css switches the whole palette from that one attribute, so the dark palette is defined
 * exactly once (there is deliberately no prefers-color-scheme media query in style.css).
 */
import type { ThemePreference } from './settings';

export type Theme = 'light' | 'dark';

/**
 * App mirrors the preference into localStorage on every settings load/save, because the
 * pre-render restore in main.tsx cannot await storage.local and a wrong theme on first paint
 * is a visible flash. A stale entry costs at most one cosmetic flip once real settings land.
 */
const CACHE_KEY = 'pageask.theme';

export function resolveTheme(pref: ThemePreference): Theme {
  if (pref === 'light' || pref === 'dark') return pref;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export function cacheThemePreference(pref: ThemePreference): void {
  try {
    localStorage.setItem(CACHE_KEY, pref);
  } catch {
    // localStorage can be unavailable (blocked storage); the cost is a one-frame theme flash
  }
}

/** Synchronous restore source for main.tsx; anything unreadable falls back to the OS scheme */
export function cachedThemePreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'auto') return raw;
  } catch {
    // fall through to the OS default
  }
  return 'auto';
}

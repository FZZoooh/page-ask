import { defineConfig } from 'wxt';
import extensionKeyJson from './extension-key.json' with { type: 'json' };
import pkg from './package.json' with { type: 'json' };

/**
 * The extension ID is derived from this public key, so it stays the same wherever the built folder
 * is loaded from — prod, dev, a copy, another machine. The backend derives the same ID from
 * extension-key.json at startup, which is why it never has to read build output.
 *
 * Read through a JSON import rather than node:fs: this project has no @types/node, and a missing
 * file already fails the build at the import instead of producing a keyless manifest.
 *
 * Generate it once with `pnpm ext:key` and commit the file; the private half never enters the repo.
 */
function readExtensionKey(): string {
  const key = typeof extensionKeyJson.key === 'string' ? extensionKeyJson.key.trim() : '';
  if (!key) throw new Error('extension-key.json has no "key": run `pnpm ext:key` once and commit the generated file');
  return key;
}

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'RightHandMan',
    // Pinned signing key: the extension ID follows from it, not from the install path (see above)
    key: readExtensionKey(),
    // Version lives only in package.json; the manifest follows it
    version: pkg.version,
    // Browser UI strings use Chrome's _locales mechanism (public/_locales/*/messages.json);
    // the manifest only carries the placeholder keys.
    default_locale: 'zh_CN',
    description: '__MSG_extDescription__',
    // sidePanel.open() requires Chrome/Edge 116+
    minimum_chrome_version: '116',
    permissions: ['sidePanel', 'scripting', 'activeTab', 'storage', 'contextMenus'],
    // Personal-use extension, never published: request permanent all-site read access.
    // If it ever ships to a store, switch to optional_host_permissions + per-site grants in the panel.
    host_permissions: ['<all_urls>'],
    side_panel: { default_path: 'sidepanel.html' },
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    },
    action: {
      default_title: '__MSG_actionTitle__',
      default_icon: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png' },
    },
  },
});

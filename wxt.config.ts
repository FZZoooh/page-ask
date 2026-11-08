import { defineConfig } from 'wxt';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'PageAsk',
    // Version lives only in package.json; the manifest follows it
    version: pkg.version,
    description: '就当前标签页内容向 AI 助手提问（侧栏）',
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
      default_title: '打开 PageAsk 侧栏',
      default_icon: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png' },
    },
  },
});

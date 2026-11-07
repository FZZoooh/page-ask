import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'PageAsk',
    version: '0.1.0',
    description: '就当前标签页内容向 AI 助手提问（侧栏）',
    minimum_chrome_version: '114',
    permissions: ['sidePanel', 'scripting', 'activeTab', 'storage', 'contextMenus'],
    // 自用扩展不上架：直接常驻全站读取权限。
    // 若日后要上架，改成 optional_host_permissions + 面板内按站点授权。
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

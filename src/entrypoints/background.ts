import { t } from '@/lib/i18n';

export default defineBackground(() => {
  // 点工具栏图标 = 直接开侧栏。
  const enableActionToOpen = () => {
    browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err: unknown) => {
      console.warn('[pageask] setPanelBehavior 失败', err);
    });
  };

  // 右键菜单：在页面任意位置右键都能开侧栏。
  // 菜单点击算用户手势，sidePanel.open 才被允许。
  //
  // 用 'all' 而不是 ['page','selection']：Edge 的内置 PDF 查看器是
  // chrome-extension://mhjfb... 的嵌入 frame，只声明 page/selection 时
  // 菜单项不会出现在 PDF 上；'all' 才行（WeTab 这类扩展也是这么做的）。
  const ensureMenu = () => {
    // 先 removeAll 再 create：扩展重载后重复 id 不会留下未捕获的 rejection
    void browser.contextMenus
      .removeAll()
      .then(() =>
        browser.contextMenus.create({
          id: 'ask-page',
          title: t('menu.askThisPage'),
          contexts: ['all'],
        }),
      )
      .catch((err: unknown) => console.warn('[pageask] 创建右键菜单失败', err));
  };

  enableActionToOpen();
  ensureMenu();
  browser.runtime.onInstalled.addListener(() => {
    enableActionToOpen();
    ensureMenu();
  });
  browser.runtime.onStartup.addListener(enableActionToOpen);

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== 'ask-page') return;
    // ⚠️ 这里不能先 await：sidePanel.open 必须紧贴事件同步调用，
    // 中间插一个 await（哪怕是 getLastFocused）手势就没了。
    // PDF 查看器里 contextMenus 给的 tab.id 是 -1、也没有可用 windowId，
    // 所以直接用常量 WINDOW_ID_CURRENT（-2），不需要任何异步调用就能拿到窗口。
    const remember = (msg: string) => {
      void browser.storage.local.set({ lastPanelOpen: msg }).catch(() => {});
    };
    const where = `tabId=${tab?.id} windowId=${tab?.windowId} url=${tab?.url ?? info.pageUrl ?? '?'}`;
    // 同步决定参数后只调用一次：catch 里再重试已经跨了 microtask，手势通常已失效。
    const target =
      typeof tab?.id === 'number' && tab.id > 0
        ? { tabId: tab.id }
        : { windowId: browser.windows.WINDOW_ID_CURRENT };
    browser.sidePanel
      .open(target)
      .then(() => remember(`ok ${JSON.stringify(target)}（${where}）`))
      .catch((err: unknown) => remember(`fail ${JSON.stringify(target)}：${String(err)}（${where}）`));
  });
});

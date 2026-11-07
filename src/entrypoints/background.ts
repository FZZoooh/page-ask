import { t } from '@/lib/i18n';

export default defineBackground(() => {
  // 点工具栏图标 = 直接开侧栏。
  const enableActionToOpen = () => {
    browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err: unknown) => {
      console.warn('[pageask] setPanelBehavior 失败', err);
    });
  };

  const openPanel = async (tabId?: number) => {
    const remember = (msg: string) => {
      // 打开失败时留个痕迹，便于在扩展的存储里排查（也会用 console 打出来）
      void browser.storage.local.set({ lastPanelOpen: msg }).catch(() => {});
    };
    // 兜底路径（非用户手势驱动时用）：tabId 优先，不行就按窗口开。
    if (typeof tabId === 'number' && tabId > 0) {
      try {
        await browser.sidePanel.open({ tabId });
        remember(`ok tabId=${tabId}`);
        return;
      } catch (err) {
        remember(`tabId 失败，改试窗口：${String(err)}`);
      }
    }
    try {
      const win = await browser.windows.getLastFocused();
      if (win.id == null) throw new Error('no focused window');
      await browser.sidePanel.open({ windowId: win.id });
      remember(`ok windowId=${win.id}`);
    } catch (err) {
      remember(`fail: ${String(err)}`);
      console.warn('[pageask] 打开侧栏失败', err);
    }
  };
  void openPanel;

  // 右键菜单：在页面任意位置右键都能开侧栏。
  // 菜单点击算用户手势，sidePanel.open 才被允许。
  //
  // 用 'all' 而不是 ['page','selection']：Edge 的内置 PDF 查看器是
  // chrome-extension://mhjfb... 的嵌入 frame，只声明 page/selection 时
  // 菜单项不会出现在 PDF 上；'all' 才行（WeTab 这类扩展也是这么做的）。
  const ensureMenu = () => {
    try {
      browser.contextMenus.create({
        id: 'ask-page',
        title: t('menu.askThisPage'),
        contexts: ['all'],
      });
    } catch {
      /* 已存在时忽略 */
    }
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
    browser.sidePanel
      .open({ windowId: browser.windows.WINDOW_ID_CURRENT })
      .then(() => remember(`ok current-window（${where}）`))
      .catch((err: unknown) => {
        remember(`current-window 失败：${String(err)}（${where}）`);
        // 再试一次 tabId（普通页面这条路更精确）
        if (typeof tab?.id === 'number' && tab.id > 0) {
          browser.sidePanel
            .open({ tabId: tab.id })
            .then(() => remember(`ok tabId=${tab.id}`))
            .catch((err2: unknown) => remember(`tabId 也失败：${String(err2)}（${where}）`));
        }
      });
  });
});

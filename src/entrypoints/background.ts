import { t } from '@/lib/i18n';

export default defineBackground(() => {
  // Clicking the toolbar icon opens the side panel directly.
  const enableActionToOpen = () => {
    browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err: unknown) => {
      console.warn('[pageask] setPanelBehavior failed', err);
    });
  };

  // Context menu: right-click anywhere on a page to open the side panel.
  // A menu click counts as a user gesture, which is what makes sidePanel.open allowed.
  //
  // Use 'all', not ['page','selection']: Edge's built-in PDF viewer is an embedded frame at
  // chrome-extension://mhjfb...; with only page/selection declared the item never shows on
  // PDFs. 'all' fixes that (extensions like WeTab do the same).
  const ensureMenu = () => {
    // removeAll, then create: on an extension reload a duplicate id would otherwise leave an uncaught rejection
    void browser.contextMenus
      .removeAll()
      .then(() =>
        browser.contextMenus.create({
          id: 'ask-page',
          title: t('menu.askThisPage'),
          contexts: ['all'],
        }),
      )
      .catch((err: unknown) => console.warn('[pageask] failed to create context menu', err));
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
    // ⚠️ Do not await first: sidePanel.open must be called synchronously inside the event —
    // insert one await (even getLastFocused) and the gesture is gone.
    // In the PDF viewer contextMenus reports tab.id = -1 and no usable windowId, so pass the
    // constant WINDOW_ID_CURRENT (-2); no async call is needed to resolve the window.
    const remember = (msg: string) => {
      void browser.storage.local.set({ lastPanelOpen: msg }).catch(() => {});
    };
    const where = `tabId=${tab?.id} windowId=${tab?.windowId} url=${tab?.url ?? info.pageUrl ?? '?'}`;
    // Pick target synchronously, call once: retrying in catch crosses a microtask and the gesture is usually gone.
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

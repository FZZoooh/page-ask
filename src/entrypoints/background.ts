import { resolveLocale, setLocale, t } from '@/lib/i18n';
import { loadSettings } from '@/lib/settings';

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
  const ensureMenu = async () => {
    // removeAll, then create: on an extension reload a duplicate id would otherwise leave an uncaught rejection
    try {
      await browser.contextMenus.removeAll();
      await browser.contextMenus.create({
        id: 'ask-page',
        title: t('menu.askThisPage'),
        contexts: ['all'],
      });
    } catch (err) {
      console.warn('[pageask] failed to create context menu', err);
    }
  };

  /** The service worker starts before the panel does, so it must load the UI locale itself. */
  const refreshMenuLocale = async () => {
    try {
      const settings = await loadSettings();
      setLocale(resolveLocale(settings.locale));
    } catch {
      /* defaults are fine */
    }
    await ensureMenu();
  };

  enableActionToOpen();
  void refreshMenuLocale();
  browser.runtime.onInstalled.addListener(() => {
    enableActionToOpen();
    void refreshMenuLocale();
  });
  browser.runtime.onStartup.addListener(enableActionToOpen);
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['pageask.settings.v2']) void refreshMenuLocale();
  });

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== 'ask-page') return;
    // ⚠️ Do not await first: sidePanel.open must be called synchronously inside the event —
    // insert one await (even getLastFocused) and the gesture is gone.
    // In the PDF viewer contextMenus reports tab.id = -1 and no usable windowId, so pass the
    // constant WINDOW_ID_CURRENT (-2); no async call is needed to resolve the window.
    // Pick target synchronously, call once: retrying in catch crosses a microtask and the gesture is usually gone.
    const target =
      typeof tab?.id === 'number' && tab.id > 0
        ? { tabId: tab.id }
        : { windowId: browser.windows.WINDOW_ID_CURRENT };
    browser.sidePanel
      .open(target)
      .catch((err: unknown) => console.warn('[pageask] sidePanel.open failed', target, err));
  });
});

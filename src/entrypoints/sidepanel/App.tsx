import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MarkdownView } from '@/components/MarkdownView';
import { IconArrowDown, IconCheck, IconCopy, IconEdit, IconQuote, IconQuoteMark, IconReload } from '@/components/icons';
import {
  getConversation,
  deleteConversation,
  listConversations,
  recoverPendingQuestion,
  streamChat,
  type ConversationMeta,
} from '@/lib/chat';
import {
  captureScreenshot,
  readActiveTab,
  readSelection,
  readSelectionText,
  readViewport,
  type ExtractedPage,
  type ReadFailure,
} from '@/lib/extract';
import { getLocale, resolveLocale, setLocale, t, tError, type MessageKey } from '@/lib/i18n';
import { pastedTextFile, transferFiles, type Attachment } from '@/lib/attachments';
import {
  applyChatActions,
  createChatStreamState,
  failChatStream,
  flushChatStream,
  reduceChatEvent,
} from './chat-stream';
import {
  DEFAULT_SETTINGS,
  isConfigured,
  loadSettings,
  normalizeUrl,
  type Settings,
} from '@/lib/settings';
import { applyTheme, cacheThemePreference, resolveTheme } from '@/lib/theme';
import { SettingsPanel } from './SettingsPanel';
import { Composer } from './Composer';
import { AttachButton, AttachmentStrip, ImageLightbox, sentCards, type PreviewTarget } from './AttachmentCards';
import { useAttachmentDrafts } from './useAttachmentDrafts';
import { HistoryPanel } from './HistoryPanel';
import { PageCard } from './PageCard';
import { RoundPanel, ThinkingFade } from './RoundPanel';
import { useConversationScroll } from './useConversationScroll';
import {
  buildRounds,
  fmtClock,
  fmtTime,
  roundEndAt,
  seconds,
  TIME_SEP_GAP_MS,
  toMessages,
  toolDetail,
  toolLabel,
  type Message,
  type Round,
} from './messages';
import {
  clearEmptyEditorResidue,
  createQuoteChip,
  decodeQuote,
  editorHasDraft as hasDraftIn,
  fillEditor as fillDomEditor,
  insertTextAtCaret as insertTextInto,
  quoteChipLabel,
  serializeEditor,
  syncEditorEmptyState,
} from './editorDom';

/** Editor max height (beyond this it scrolls internally); must match .editor max-height in style.css */
const MAX_BOX_H = 156;
/** Single-line editor height (22px line + 2×6px padding); must match .editor in style.css */
const SINGLE_LINE_H = 34;
/** Extra left inset of the editor in one-row mode, where "+" sits beside it (.box vs .box.multi padding) */
const SINGLE_ROW_INSET = 30;
/** Messages per history page; the backend clamps to 500 */
const HISTORY_PAGE_SIZE = 200;

/**
 * URL whose latest conversation the user explicitly abandoned with "New chat". It has to outlive the
 * panel document (a reload or closing/reopening the side panel remounts everything and would otherwise
 * auto-resume the latest conversation again), so it lives in session storage: it survives panel
 * reloads for the current browser session but not a browser restart, where resuming is expected again.
 */
const NEW_CHAT_KEY = 'pageask.newChatUrl';

async function loadNewChatUrl(): Promise<string | null> {
  try {
    const stored = await browser.storage.session.get(NEW_CHAT_KEY);
    const url = stored[NEW_CHAT_KEY];
    return typeof url === 'string' ? url : null;
  } catch {
    return null;
  }
}

function saveNewChatUrl(url: string | null): void {
  // Fire-and-forget: losing the flag only restores the old auto-resume behavior.
  const write = url
    ? browser.storage.session.set({ [NEW_CHAT_KEY]: url })
    : browser.storage.session.remove(NEW_CHAT_KEY);
  void write.catch(() => {});
}

type PageState =
  | { kind: 'loading' }
  | { kind: 'ready'; page: ExtractedPage }
  | { kind: 'failed'; failure: ReadFailure };

const REASON_HINT: Record<ReadFailure['reason'], MessageKey> = {
  restricted: 'page.failure.restricted',
  permission: 'page.failure.permission',
  empty: 'page.failure.empty',
  unknown: 'page.failure.unknown',
};

const SUGGESTION_KEYS: MessageKey[] = [
  'empty.suggestion.summary',
  'empty.suggestion.threePoints',
  'empty.suggestion.example',
];

/** Prefer local copy when the backend supplies an error code, else fall back to the raw message */
function serverErrorText(
  code: string | undefined,
  params: Record<string, string | number> | undefined,
  message: string,
): string {
  return tError(code, params, message);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Render quote chips in user bubbles as inline quotes; everything else stays plain text.
 * <pageask-quote> carries quoted text/formulas, <pageask-file> an artifact reference; both come
 * from chips the composer serialized. The backend converts chips to Markdown blockquotes for the
 * model — a literal <q> typed in an HTML discussion is no chip and renders as plain text.
 */
function renderUserText(content: string) {
  return content.split(/(<pageask-quote>[\s\S]*?<\/pageask-quote>|<pageask-file>[\s\S]*?<\/pageask-file>)/g).map((part, i) => {
    const m = /^<(pageask-quote|pageask-file)>([\s\S]*)<\/\1>$/.exec(part);
    if (m) {
      const text = decodeQuote(m[2] ?? '');
      // Same display rule as the composer chip: first line only, Unicode for formulas. The full
      // quote stays in the stored message; only the bubble rendering is shortened.
      return (
        <span className="bubble-q" key={i}>
          <span className="bubble-q-text">{quoteChipLabel(text)}</span>
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
}
export default function App() {
  const [pageState, setPageState] = useState<PageState>({ kind: 'loading' });
  const [showPageText, setShowPageText] = useState(false);
  const [copied, setCopied] = useState(false);

  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Set when the backend just generated the title: runs the left-to-right fade once, not on history loads */
  const [titlePulse, setTitlePulse] = useState(false);

  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** Banner above the list when loading history / switching conversations fails; never replaces messages */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyBefore, setHistoryBefore] = useState<string | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ localId: string; serverId: string; content: string } | null>(null);
  const [editDraft, setEditDraft] = useState('');
  /** Page selection shown on the editor's first line (hint only; send carries its own selection context) */
  const [selectionHint, setSelectionHint] = useState('');
  /** Floating "Quote" button when answer text is selected (viewport coords + the selected source text) */
  const [quoteMenu, setQuoteMenu] = useState<{ left: number; top: number; text: string } | null>(null);

  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current != null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  }, []);

  /** Attachment cards of the composer and of the inline question editor (independent drafts) */
  const composerFiles = useAttachmentDrafts(settings, showToast);
  const editFiles = useAttachmentDrafts(settings, showToast);
  /** Composer two-row layout (wrapped text or attachments): see the auto-grow effect */
  const [composerMulti, setComposerMulti] = useState(false);
  const composerMultiRef = useRef(false);
  const growAnimRef = useRef(0);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [composerFloating, setComposerFloating] = useState(false);
  const composerExpandedRef = useRef(false);
  const composerTransitionRef = useRef<{ height: number; backdrop: number } | null>(null);
  const composerExpandingRef = useRef(false);
  const composerModeFromRef = useRef<number | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const [composerSpace, setComposerSpace] = useState({ height: 0, width: 0 });
  const requestComposerExpanded = useCallback((next: boolean) => {
    if (next === composerExpandedRef.current) return;
    const box = editorRef.current?.parentElement;
    const composer = box?.parentElement;
    if (!box || !composer) return;
    composerTransitionRef.current = {
      height: box.getBoundingClientRect().height,
      backdrop: Number(composer.style.getPropertyValue('--composer-backdrop')),
    };
    // Keep the list's viewport unchanged while the editor floats above it.
    if (next && !composer.style.height) composer.style.height = `${composer.getBoundingClientRect().height}px`;
    composerExpandingRef.current = true;
    composerExpandedRef.current = next;
    setComposerFloating(true);
    setComposerExpanded(next);
  }, []);
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const closePreview = useCallback(() => setPreview(null), []);

  const seq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  /** Synchronous "sending" gate: busy is state, so a double click passes twice before the re-render */
  const sendingRef = useRef(false);
  /** Bumped on every send; a late finally must not clear the next run's busy state */
  const runSeqRef = useRef(0);
  /** PDF reads need the backend URL + token, but load() must stay stable, so keep them in refs */
  const backendRef = useRef<string>(DEFAULT_SETTINGS.backendUrl);
  const tokenRef = useRef<string>('');

  const editorRef = useRef<HTMLDivElement | null>(null);
  /** Inline question editor (rendered in place of a user bubble); kept uncontrolled like the composer */
  const inlineEditorRef = useRef<HTMLDivElement | null>(null);
  /** Last caret inside the editor: selecting elsewhere replaces the document selection; restore this */
  const savedRange = useRef<Range | null>(null);
  /** Async callbacks must ask "did the user already send?", and only a ref holds the latest value */
  const messagesRef = useRef<Message[]>([]);
  /** Conversation load sequence: on tab switches or rapid history clicks only the latest request wins */
  const loadSeqRef = useRef(0);
  /** When the current page snapshot was read; sending refreshes stale SPA content */
  const pageLoadedAtRef = useRef(0);
  /** Latest extracted identity, used to keep same-document URL updates out of the UI reset path */
  const currentPageRef = useRef<ExtractedPage | null>(null);
  /** After "New chat", keep the same page from auto-resuming its latest conversation again */
  const suppressedResumeUrl = useRef<string | null>(null);

  const fillEditor = useCallback((text: string) => {
    const el = editorRef.current;
    if (el) {
      fillDomEditor(el, text);
      syncEditorEmptyState(el);
    }
    setInput(text);
  }, []);

  const editorHasDraft = useCallback(() => hasDraftIn(editorRef.current), []);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    if (settings?.backendUrl) backendRef.current = settings.backendUrl;
    tokenRef.current = settings?.token ?? '';
  }, [settings]);

  const page = pageState.kind === 'ready' ? pageState.page : null;
  const pageUrl = page?.pageUrl ?? null;
  const configured = isConfigured(settings);
  /** Verbose mode: when off only answer text remains; page card, thinking block and stats all hide */
  const verbose = settings?.verbose !== false;

  /* ---------------- Conversation list ---------------- */

  const refreshConversations = useCallback(
    async (url: string, s: Settings, commit = true) => {
      try {
        const list = await listConversations(s, url);
        if (commit) {
          setConversations(list);
          setLoadError(null);
        }
        return list;
      } catch {
        // Keep the list we already have: a backend hiccup must not look like "no history".
        setLoadError(t('error.historyUnavailable'));
        return [];
      }
    },
    [],
  );

  const toggleHistory = useCallback(() => {
    requestComposerExpanded(false);
    const next = !historyOpen;
    setHistoryOpen(next);
    // Opening the panel is also a retry: a backend that was down when the tab loaded may be back now.
    if (next && pageUrl && settings) void refreshConversations(pageUrl, settings);
  }, [historyOpen, pageUrl, settings, refreshConversations, requestComposerExpanded]);

  /* ---------------- Page loading ---------------- */

  const load = useCallback(async (preservePage = false) => {
    const mine = ++seq.current;
    if (!preservePage) {
      currentPageRef.current = null;
      setPageState({ kind: 'loading' });
    }
    const result = await readActiveTab({ backendUrl: backendRef.current, token: tokenRef.current });
    if (mine !== seq.current) return; // a newer read started; drop this result
    if (result.ok) {
      pageLoadedAtRef.current = Date.now();
      const nextPage = {
        ...result.page,
        url: normalizeUrl(result.page.url),
        pageUrl: normalizeUrl(result.page.pageUrl),
      };
      const silent = preservePage && currentPageRef.current?.pageUrl === nextPage.pageUrl;
      currentPageRef.current = nextPage;
      setPageState({ kind: 'ready', page: nextPage });
      if (!silent) setShowPageText(false);
    } else {
      currentPageRef.current = null;
      setPageState({ kind: 'failed', failure: result });
      setShowPageText(false);
    }
  }, []);

  useEffect(() => {
    // Wait for stored settings: a PDF needs the backend token, and loading once with an empty token
    // would show a 401 until the next tab event. Re-running on token changes also picks up a new token.
    if (!settings) return;
    void load();
    let urlTimer: number | null = null;
    const cancelPendingUrl = () => {
      if (urlTimer != null) window.clearTimeout(urlTimer);
      urlTimer = null;
    };
    const onActivated = () => {
      cancelPendingUrl();
      void load();
    };
    const ifActiveMainFrame = async (details: { tabId: number; frameId: number }, run: () => void) => {
      if (details.frameId !== 0) return;
      try {
        const tab = await browser.tabs.get(details.tabId);
        if (tab.active) run();
      } catch {
        // The tab may close between the navigation event and the lookup.
      }
    };
    const onHistoryStateUpdated = (details: { tabId: number; frameId: number }) => {
      void ifActiveMainFrame(details, () => {
        // pushState/replaceState includes passive scroll markers, not just application routes.
        cancelPendingUrl();
        urlTimer = window.setTimeout(() => {
          urlTimer = null;
          void load(true);
        }, 150);
      });
    };
    const onCompleted = (details: { tabId: number; frameId: number }) => {
      void ifActiveMainFrame(details, () => {
        cancelPendingUrl();
        void load();
      });
    };
    browser.tabs.onActivated.addListener(onActivated);
    browser.webNavigation.onHistoryStateUpdated.addListener(onHistoryStateUpdated);
    browser.webNavigation.onCompleted.addListener(onCompleted);
    return () => {
      cancelPendingUrl();
      browser.tabs.onActivated.removeListener(onActivated);
      browser.webNavigation.onHistoryStateUpdated.removeListener(onHistoryStateUpdated);
      browser.webNavigation.onCompleted.removeListener(onCompleted);
    };
  }, [load, settings?.backendUrl, settings?.token]);

  /* ---------------- Page selection hint ---------------- */

  // There is no selection event to subscribe to (no persistent content script), so poll plain text lightly;
  // users mostly select on the page then click back into the panel, so refresh once on focus as well.
  // Skip PDFs: the embedded viewer exposes no DOM, so injection would just fail every second.
  useEffect(() => {
    if (pageState.kind !== 'ready' || pageState.page.kind === 'pdf' || !configured) {
      setSelectionHint('');
      return;
    }
    let alive = true;
    let inFlight = false;
    const refresh = async () => {
      if (!alive || inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      try {
        const text = await readSelectionText();
        if (alive) setSelectionHint((prev) => (prev === text ? prev : text));
      } finally {
        inFlight = false;
      }
    };
    const tick = () => void refresh();
    void refresh();
    const timer = window.setInterval(tick, 1000);
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', tick);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [pageState.kind, page?.kind, page?.pageUrl, configured]);

  useEffect(() => {
    // Restore the "New chat" intent together with the settings: the tab effect below runs as soon as
    // settings lands, and a restored intent must already be in place when it decides to auto-resume.
    void Promise.all([loadSettings(), loadNewChatUrl()]).then(([next, newChatUrl]) => {
      if (newChatUrl) suppressedResumeUrl.current = newChatUrl;
      setLocale(resolveLocale(next.locale));
      setSettings(next);
    });
  }, []);

  // Sync <html lang> on locale change: screen readers and spell check both rely on it
  useEffect(() => {
    document.documentElement.lang = getLocale();
  }, [settings]);

  // Reading size lives on <html> as a data attribute so CSS can size answer text and em-based
  // KaTeX from one value without re-rendering every block.
  useEffect(() => {
    document.documentElement.dataset.fontSize = settings?.fontSize ?? DEFAULT_SETTINGS.fontSize;
  }, [settings]);

  // Theme also lives on <html> (data-theme). While settings are still loading, keep whatever
  // main.tsx restored from the cache: applying the 'auto' fallback here would visibly flip a
  // forced dark theme light for a frame.
  useEffect(() => {
    if (!settings) return;
    const pref = settings.theme;
    const apply = () => applyTheme(resolveTheme(pref));
    apply();
    cacheThemePreference(pref);
    // 'auto' must track a mid-session OS scheme switch; the media query used to do that for free
    if (pref !== 'auto') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [settings]);

  /* ---------------- Tab change → conversation change ---------------- */

  useEffect(() => {
    // Abort the old run on any tab switch, even to an unreadable page, so it can't write into the new one
    if (abortRef.current || sendingRef.current) {
      runSeqRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      sendingRef.current = false;
      setBusy(false);
    }

    if (!pageUrl || !settings) {
      // An unreadable page must not keep showing the previous page's answer.
      loadSeqRef.current += 1;
      // Not cleared: pageState briefly drops to loading on a web-page reload, and the "New chat"
      // intent for this URL must survive that cycle. The mismatch check below drops it on a real
      // page change.
      setConversationId(null);
      setMessages([]);
      setHistoryOpen(false);
      setLoadError(null);
      setHistoryHasMore(false);
      setHistoryBefore(null);
      setLoadingEarlier(false);
      return;
    }

    // After a tab/backend change the previous page's answer no longer belongs here. The server persists
    // whatever was generated, flagged aborted, but the new page must never receive the old run's events.
    if (suppressedResumeUrl.current && suppressedResumeUrl.current !== pageUrl) {
      suppressedResumeUrl.current = null;
      saveNewChatUrl(null);
    }
    const mine = ++loadSeqRef.current;
    let cancelled = false;
    setConversationId(null);
    setMessages([]);
    setHistoryOpen(false);
    setLoadError(null);
    setHistoryHasMore(false);
    setHistoryBefore(null);
    setLoadingEarlier(false);

    void (async () => {
      const list = await refreshConversations(pageUrl, settings, false);
      const latest = list[0];
      if (cancelled || mine !== loadSeqRef.current) return;
      setConversations(list);
      // The user asked for a blank conversation on this page: don't immediately restore list[0] again.
      if (suppressedResumeUrl.current === pageUrl) return;
      if (!latest) return;
      // Auto-resume this page's most recent conversation
      try {
        const conv = await getConversation(settings, latest.id, { limit: HISTORY_PAGE_SIZE });
        if (cancelled || mine !== loadSeqRef.current) return;
        // The user may have sent during those two round-trips; never overwrite the message list wholesale
        if (sendingRef.current || messagesRef.current.length > 0) return;
        let stored = conv.messages;
        // A crash leaves a final user message unanswered: move it to the editor and drop it from history
        if (!editorHasDraft() && !composerFiles.hasItems()) {
          const recovered = await recoverPendingQuestion(settings, conv.id).catch(() => null);
          if (cancelled || mine !== loadSeqRef.current) return;
          if (sendingRef.current || messagesRef.current.length > 0) return;
          if (recovered) {
            stored = stored.filter((m) => m.id !== recovered.messageId);
            fillEditor(recovered.text);
            // Recovery returns the files to pending, so the composer owns them again
            composerFiles.reset(recovered.attachments ?? [], true);
            void refreshConversations(pageUrl, settings);
          }
        }
        setConversationId(conv.id);
        setMessages(toMessages(stored, page?.kind === 'pdf'));
        setHistoryHasMore(conv.hasMore === true);
        setHistoryBefore(conv.nextBefore ?? null);
      } catch (err) {
        if (cancelled || mine !== loadSeqRef.current) return;
        setLoadError(t('error.historyLoad', { message: errText(err) }));
      }
    })();

    return () => {
      cancelled = true;
    };
    // verbose is not a dep: toggling display must not reload the conversation; only tab/backend changes re-home
  }, [
    pageUrl,
    settings?.backendUrl,
    refreshConversations,
    fillEditor,
    editorHasDraft,
    page?.kind,
    composerFiles.hasItems,
    composerFiles.reset,
  ]);

  const {
    listRef,
    spacerRef,
    leadSpacerRef,
    latestUserRef,
    editingUserRef,
    listEndRef,
    showScrollBtn,
    prepareSend,
    conversationAssigned,
    clearCenterLock,
    scrollToBottom,
    resetScroll,
    followBottom,
    preparePrepend,
    restorePrepend,
    cancelPrepend,
    revealEditing,
    noteUserScroll,
    onScroll,
  } = useConversationScroll({ messages, conversationId });

  const handleListScroll = () => {
    setQuoteMenu(null);
    onScroll();
  };

  /* ---------------- Answer selection → quote ---------------- */

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const hide = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      setQuoteMenu(null);
    };

    const update = () => {
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? '';
      if (!sel || sel.rangeCount === 0 || text.length < 2) {
        hide();
        return;
      }
      const range = sel.getRangeAt(0);
      const node = range.commonAncestorContainer;
      const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
      // Only for text inside an assistant answer (never user bubbles or step rows)
      if (!el?.closest('.answer')) {
        hide();
        return;
      }
      const rect = range.getBoundingClientRect();
      if (!rect.width && !rect.height) {
        hide();
        return;
      }
      setQuoteMenu({
        left: Math.min(Math.max(rect.left + rect.width / 2, 52), window.innerWidth - 52),
        top: Math.max(rect.top - 6, 40),
        text: text.slice(0, 2000),
      });
    };

    const onUp = (e: MouseEvent) => {
      // Don't clear when the click lands on the quote button itself, or the menu dies before click fires
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('.quote-btn')) return;
      update();
    };

    // Keyboard selection never fires mouseup; selectionchange is the only common signal.
    const onSelectionChange = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(update, 160);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        hide();
        return;
      }
      if (e.shiftKey || e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') {
        if (timer) clearTimeout(timer);
        timer = setTimeout(update, 80);
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };

    document.addEventListener('mouseup', onUp);
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', hide);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', hide);
    };
  }, []);

  const serialize = useCallback(() => {
    const text = serializeEditor(editorRef.current);
    syncEditorEmptyState(editorRef.current);
    return text;
  }, []);

  /** Plain-text insert for paste/drop; runs through the native editor commands so Ctrl+Z can undo it */
  const insertTextAtCaret = useCallback((text: string) => {
    const el = editorRef.current;
    if (!el) return;
    insertTextInto(el, text, savedRange.current);
    setInput(serialize());
  }, [serialize]);

  /** Insert a quote chip at the caret: contenteditable=false, so editing treats it as one character */
  const insertQuoteChip = useCallback((text: string, file = false) => {
    const el = editorRef.current;
    if (!el) return;
    // The answer selection is not the insertion target: savedRange is the composer caret the user
    // left before selecting the answer. Snapshot it before focus(), because focusing an editor with
    // no live selection can put the caret at the start, which would win over the saved position.
    const saved = savedRange.current;
    el.focus();
    const sel = window.getSelection();
    let range: Range | null = saved && el.contains(saved.startContainer) ? saved.cloneRange() : null;
    if (!range && sel && sel.rangeCount > 0) {
      const cur = sel.getRangeAt(0);
      if (el.contains(cur.commonAncestorContainer)) range = cur;
    }
    if (!range) {
      range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
    }
    range.deleteContents();

    const chip = createQuoteChip(text, file);

    range.insertNode(chip);

    // Put the caret after the chip. Chromium can stop right after an inline element, no zero-width
    // placeholder needed (it adds an extra arrow-key stop, so navigation seems to stick for a beat).
    const after = document.createRange();
    after.setStartAfter(chip);
    after.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(after);
    savedRange.current = after.cloneRange();

    setInput(serialize());
  }, [serialize]);

  /** The artifact card's quote button inserts a file reference chip for the workspace file */
  const insertFileChip = useCallback((name: string) => insertQuoteChip(name, true), [insertQuoteChip]);

  /** Insert the selected answer text as a quote chip at the caret */
  const applyQuote = () => {
    if (!quoteMenu) return;
    const text = quoteMenu.text.trim();
    setQuoteMenu(null);
    window.getSelection()?.removeAllRanges();
    if (!text) return;
    requestAnimationFrame(() => insertQuoteChip(text));
  };

  /* ---------------- Sending ---------------- */

  const canSend =
    configured &&
    !busy &&
    !composerFiles.uploading &&
    (input.trim().length > 0 || composerFiles.items.length > 0);

  const send = useCallback(
    async (
      raw?: string,
      opts?: { regenerate?: boolean; editMessageId?: string; editLocalId?: string; attachments?: Attachment[] },
    ) => {
      const editMessageId = opts?.editMessageId;
      const editingQuestion = Boolean(editMessageId);
      const regenerate = Boolean(opts?.regenerate) && !editingQuestion;
      const fresh = !regenerate && !editingQuestion;
      const question = (raw ?? serialize()).trim();
      // A fresh send takes the composer's cards; an edit brings its own list (always sent, even empty,
      // so removed files get unbound); a regenerate leaves the stored attachments alone.
      const pendingFiles = fresh ? composerFiles.items : [];
      if (fresh && composerFiles.uploading) return;
      if (!question && !regenerate && !(editingQuestion ? opts?.attachments?.length : pendingFiles.length)) return;
      if (!settings || busy || sendingRef.current) return;
      if (!isConfigured(settings) || !page) return;
      if ((regenerate || editingQuestion) && !conversationId) return;
      if (editingQuestion && !opts?.editLocalId) return;

      const runId = ++runSeqRef.current;
      abortRef.current?.abort();
      sendingRef.current = true;
      if (suppressedResumeUrl.current) {
        suppressedResumeUrl.current = null;
        saveNewChatUrl(null);
      }
      const files = editingQuestion ? (opts?.attachments ?? []) : fresh ? composerFiles.take() : [];
      if (fresh) {
        requestComposerExpanded(false);
        setInput('');
        if (editorRef.current) {
          editorRef.current.innerHTML = '';
          syncEditorEmptyState(editorRef.current);
        }
        savedRange.current = null;
      }
      prepareSend({
        center: fresh,
        editing: editingQuestion,
        newConversation: !conversationId,
      });

      const firstAsstId = crypto.randomUUID();
      const localAttachments = files.length ? files : undefined;
      // A fresh send keeps a local id until `meta` reports the DB id. Editing an existing row reuses
      // its local id (so the DOM stays stable) and already knows the DB id.
      const localUserId = editingQuestion ? (opts?.editLocalId ?? null) : regenerate ? null : crypto.randomUUID();
      setMessages((prev) => {
        if (editingQuestion && localUserId) {
          // Overwrite semantics: the edited question and everything after it are replaced locally,
          // matching the backend's edit + truncate.
          const at = prev.findIndex((m) => m.id === localUserId);
          const kept = at >= 0 ? prev.slice(0, at) : prev;
          return [
            ...kept,
            {
              id: localUserId,
              serverId: editMessageId,
              role: 'user' as const,
              content: question,
              attachments: localAttachments,
              createdAt: Date.now(),
            },
            { id: firstAsstId, role: 'assistant', content: '', reasoning: '', streaming: true },
          ];
        }
        return [
          ...prev,
          ...(localUserId
            ? [
                {
                  id: localUserId,
                  role: 'user' as const,
                  content: question,
                  attachments: localAttachments,
                  createdAt: Date.now(),
                },
              ]
            : []),
          { id: firstAsstId, role: 'assistant', content: '', reasoning: '', streaming: true },
        ];
      });

      const controller = new AbortController();
      abortRef.current = controller;
      setBusy(true);

      let stream = createChatStreamState(firstAsstId, conversationId, localUserId);
      const streamIO = {
        createId: () => crypto.randomUUID(),
        toolLabel: (name: string) => toolLabel(name, page.kind === 'pdf'),
        toolDetail,
        errorText: (event: { code?: string; params?: Record<string, string | number>; message: string }) =>
          serverErrorText(event.code, event.params, event.message),
      };
      const commit = (transition: ReturnType<typeof flushChatStream>) => {
        stream = transition.state;
        if (transition.actions.length) {
          setMessages((prev) => applyChatActions(prev, transition.actions));
        }
      };
      let timer: ReturnType<typeof setTimeout> | null = null;
      const flush = () => {
        timer = null;
        commit(flushChatStream(stream));
      };
      const schedule = () => {
        if (timer) return;
        timer = setTimeout(flush, 50);
      };
      let answerEnded = false;
      const endAnswer = () => {
        if (answerEnded || runSeqRef.current !== runId) return;
        answerEnded = true;
        clearCenterLock();
      };

      // Snapshot the visible area first: the screenshot tool needs it, and it never goes upstream otherwise.
      // Both screenshot and selection reads sit in try, so a failure still reaches finally and frees the gate.
      try {
        // SPA content can change without a tab update. Re-read the body on an old snapshot, but never
        // block the send if extraction fails; PDFs are excluded because re-downloading is expensive.
        let snapshot = page;
        if (page.kind !== 'pdf' && Date.now() - pageLoadedAtRef.current > 5000) {
          const fresh = await readActiveTab({ backendUrl: backendRef.current, token: tokenRef.current }).catch(
            () => null,
          );
          if (fresh?.ok && normalizeUrl(fresh.page.pageUrl) === page.pageUrl) {
            snapshot = {
              ...fresh.page,
              url: normalizeUrl(fresh.page.url),
              pageUrl: page.pageUrl,
              selection: page.selection,
            };
            pageLoadedAtRef.current = Date.now();
          }
        }
        // Screenshot, selection and viewport are independent: fetch in parallel to save a serial round-trip.
        // The viewport is re-read here because the page snapshot dates from panel load and goes stale on scroll.
        const [shot, sel, vp] = await Promise.all([
          captureScreenshot(snapshot.url),
          readSelection(snapshot.url),
          snapshot.kind === 'pdf' ? Promise.resolve(null) : readViewport(snapshot.url),
        ]);
        const selected = (sel?.text || snapshot.selection || '').trim();
        if (runSeqRef.current !== runId || controller.signal.aborted) return;
        if (localUserId) {
          setMessages((prev) => prev.map((m) => m.id === localUserId ? { ...m, selection: selected } : m));
        }

        for await (const ev of streamChat({
          settings,
          conversationId,
          page: {
            url: snapshot.url,
            pageUrl: snapshot.pageUrl,
            title: snapshot.title,
            markdown: snapshot.markdown,
            viewport: vp ?? snapshot.viewport,
            kind: snapshot.kind ?? 'web',
            pages: snapshot.pages,
            selection: selected,
            selectionContext: sel,
          },
          screenshot: shot,
          text: question,
          attachments: regenerate ? undefined : editingQuestion || files.length ? files.map((a) => a.id) : undefined,
          regenerate,
          editMessageId,
          locale: getLocale(),
          signal: controller.signal,
        })) {
          // A tab switch aborts and bumps runSeq; this extra guard keeps old-run events out of the new page.
          // Title is conversation-scoped and can arrive after the answer is done (auto-title), so it must
          // still update the history list even if the user has already started the next run.
          if (ev.type === 'title') {
            setConversations((prev) =>
              prev.map((c) => (c.id === ev.conversationId ? { ...c, title: ev.title } : c)),
            );
            setTitlePulse(true);
            continue;
          }
          if (runSeqRef.current !== runId) break;
          if (ev.type === 'replace' && timer) {
            clearTimeout(timer);
            timer = null;
          }
          if ((ev.type === 'tool' && ev.phase === 'start') || ev.type === 'done' || ev.type === 'error') flush();
          commit(reduceChatEvent(stream, ev, streamIO));
          if (ev.type === 'content' || ev.type === 'reasoning') schedule();
          if (ev.type === 'meta') {
            conversationAssigned(ev.conversationId);
            setConversationId(ev.conversationId);
          } else if (ev.type === 'done') {
            endAnswer();
            // Answer done: release the editor now instead of holding the connection ~20s for auto-title
            sendingRef.current = false;
            setBusy(false);
          } else if (ev.type === 'error') {
            endAnswer();
          }
        }
        if (runSeqRef.current === runId && !stream.sawDone && !stream.sawError) {
          if (controller.signal.aborted) {
            commit(failChatStream(stream, t('answer.stopped'), streamIO.createId));
          } else {
            throw new Error(t('error.streamCut'));
          }
        }
      } catch (err) {
        if (runSeqRef.current !== runId) return;
        commit(flushChatStream(stream));
        // After done only auto-title/connection teardown remain; a cut there doesn't affect the full answer
        if (stream.sawDone || stream.sawError) return;
        const stopped = controller.signal.aborted;
        commit(
          failChatStream(stream, stopped ? t('answer.stopped') : errText(err), streamIO.createId),
        );
      } finally {
        if (timer) clearTimeout(timer);
        // When a new run already started, a late cleanup must not clear its busy flag/gate
        if (runSeqRef.current === runId) {
          endAnswer();
          abortRef.current = null;
          sendingRef.current = false;
          setBusy(false);
          if (stream.conversationId) void refreshConversations(page.pageUrl, settings);
        }
      }
    },
    [
      busy,
      clearCenterLock,
      composerFiles,
      conversationAssigned,
      conversationId,
      input,
      page,
      prepareSend,
      requestComposerExpanded,
      refreshConversations,
      serialize,
      settings,
    ],
  );

  const [copiedId, setCopiedId] = useState<string | null>(null);
  /** Separate from copiedId: a question and an answer are different buttons in the same turn */
  const [copiedUserId, setCopiedUserId] = useState<string | null>(null);

  // Fill and focus the inline editor once it is in the DOM. Content is rendered imperatively (quote
  // chips need real spans), so React must not own the children of this contenteditable.
  useLayoutEffect(() => {
    if (!editing) return;
    const el = inlineEditorRef.current;
    if (!el) return;
    fillDomEditor(el, editing.content);
    setEditDraft(serializeEditor(el));
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    revealEditing();
  }, [editing, revealEditing]);

  // A different page or conversation invalidates the open editor (its row may no longer exist).
  useEffect(() => {
    clearCenterLock();
    setEditing(null);
    setEditDraft('');
    editFiles.discardNew();
  }, [conversationId, pageUrl, clearCenterLock, editFiles.discardNew]);

  const stop = () => abortRef.current?.abort();

  /**
   * Copy the answer's raw Markdown; on success the icon briefly turns into a check.
   * One turn can have several answer segments (reasoning/tool calls split them) and the button
   * hangs on the last one only, so copy concatenates every segment in order.
   */
  const copyRound = useCallback((r: Round, anchorId: string) => {
    const text = r.phases
      .flatMap((p) => p.answers)
      .map((a) => a.content.trim())
      .filter(Boolean)
      .join('\n\n');
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopiedId(anchorId);
        window.setTimeout(() => setCopiedId((cur) => (cur === anchorId ? null : cur)), 1400);
      })
      .catch(() => showToast(t('answer.copyFailed')));
  }, [showToast]);

  /**
   * Copy the user's own question. Chips are stored as <pageask-quote>/<pageask-file>, so turn them
   * back into plain text instead of leaking the markers into the clipboard. Both kinds come out
   * quoted — the file reference as a whole, "file: name" — with one space outside each quote pair.
   */
  const copyQuestion = useCallback((m: Message) => {
    const text = m.content
      .replace(/<pageask-quote>([\s\S]*?)<\/pageask-quote>/g, (_all, quote: string) => ` "${decodeQuote(quote)}" `)
      .replace(/<pageask-file>([\s\S]*?)<\/pageask-file>/g, (_all, name: string) => ` "file: ${decodeQuote(name)}" `);
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopiedUserId(m.id);
        window.setTimeout(() => setCopiedUserId((cur) => (cur === m.id ? null : cur)), 1400);
      })
      .catch(() => showToast(t('answer.copyFailed')));
  }, [showToast]);

  /**
   * Open the in-place editor for a past question. Unlike the old composer refill, Send rewrites this
   * message in the backend and regenerates from it (later turns are overwritten on purpose).
   */
  const startEdit = useCallback(
    (m: Message) => {
      if (busy || sendingRef.current) return;
      // Editing takes over scrolling; a still-active send lock would snap the row back on open.
      clearCenterLock();
      editFiles.reset(m.attachments ?? [], false);
      setEditing({ localId: m.id, serverId: m.serverId ?? m.id, content: m.content });
      setEditDraft(m.content);
    },
    [busy, clearCenterLock, editFiles.reset],
  );

  const cancelEdit = useCallback(() => {
    // The anchor lock belongs to editing; keep the collapsed editor from holding a stale offset.
    clearCenterLock();
    setEditing(null);
    setEditDraft('');
    editFiles.discardNew();
  }, [clearCenterLock, editFiles.discardNew]);

  const onEditInput = useCallback(() => {
    setEditDraft(serializeEditor(inlineEditorRef.current));
  }, []);

  const submitEdit = useCallback(() => {
    if (!editing) return;
    const el = inlineEditorRef.current;
    const text = (el ? serializeEditor(el) : editDraft).trim();
    if ((!text && !editFiles.items.length) || editFiles.uploading || busy || sendingRef.current) return;
    if (!settings || !isConfigured(settings) || !page || !conversationId) return;
    const { localId, serverId } = editing;
    setEditing(null);
    setEditDraft('');
    const attachments = editFiles.take();
    void send(text, { editMessageId: serverId, editLocalId: localId, attachments });
  }, [busy, conversationId, editDraft, editFiles, editing, page, send, settings]);

  const onEditPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    const files = transferFiles(e.clipboardData);
    if (!text && files.length) {
      editFiles.add(files);
      return;
    }
    const asFile = settings ? pastedTextFile(settings, text.replace(/\r\n?/g, '\n')) : null;
    if (asFile) {
      editFiles.add([asFile]);
      return;
    }
    const el = inlineEditorRef.current;
    if (!text || !el) return;
    insertTextInto(el, text, null);
    onEditInput();
  };

  const onEditDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const files = transferFiles(e.dataTransfer);
    if (files.length) editFiles.add(files);
  };

  const onEditKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Enter must not send while an IME is composing candidates
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
      return;
    }
    if (e.key !== 'Enter') return;
    if (e.shiftKey) {
      e.preventDefault();
      // Native command keeps the trailing placeholder line, same as the composer
      document.execCommand('insertLineBreak');
      onEditInput();
      return;
    }
    e.preventDefault();
    submitEdit();
  };

  /** Regenerate a turn: drop its answers locally, then rerun the same question with regenerate */
  const regenerateRound = useCallback(
    (r: Round) => {
      // Check every send precondition first, or the UI truncates while no request goes out
      if (busy || sendingRef.current || !settings || !isConfigured(settings) || !page || !conversationId) return;
      const question = r.user?.content ?? '';
      if (!question && !r.user?.attachments?.length) return;
      // Keep only the messages up to and including this user message
      const cutAt = r.user ? messages.findIndex((m) => m.id === r.user!.id) : messages.length;
      if (cutAt >= 0) setMessages((prev) => prev.slice(0, cutAt + 1));
      void send(question, { regenerate: true });
    },
    [busy, conversationId, messages, page, send, settings],
  );

  const newConversation = () => {
    if (busy) return;
    resetScroll();
    loadSeqRef.current += 1; // invalidate in-flight history loads so they can't refill the empty conversation
    suppressedResumeUrl.current = pageUrl;
    saveNewChatUrl(pageUrl);
    setConversationId(null);
    setMessages([]);
    setHistoryOpen(false);
    setLoadError(null);
    setHistoryHasMore(false);
    setHistoryBefore(null);
    setLoadingEarlier(false);
  };

  const openConversation = async (id: string) => {
    if (!settings || busy || id === conversationId) {
      setHistoryOpen(false);
      return;
    }
    suppressedResumeUrl.current = null;
    saveNewChatUrl(null);
    const mine = ++loadSeqRef.current;
    try {
      const conv = await getConversation(settings, id, { limit: HISTORY_PAGE_SIZE });
      if (mine !== loadSeqRef.current) return;
      if (pageUrl && conv.url !== normalizeUrl(pageUrl)) {
        setLoadError(t('error.historyLoad', { message: t('error.pageMismatch') }));
        return;
      }
      let stored = conv.messages;
      if (!editorHasDraft() && !composerFiles.hasItems()) {
        const recovered = await recoverPendingQuestion(settings, conv.id).catch(() => null);
        if (mine !== loadSeqRef.current) return;
        if (recovered) {
          stored = stored.filter((m) => m.id !== recovered.messageId);
          fillEditor(recovered.text);
          composerFiles.reset(recovered.attachments ?? [], true);
          if (pageUrl) void refreshConversations(pageUrl, settings);
        }
      }
      setConversationId(conv.id);
      setMessages(toMessages(stored, page?.kind === 'pdf'));
      setLoadError(null);
      setHistoryHasMore(conv.hasMore === true);
      setHistoryBefore(conv.nextBefore ?? null);
      setLoadingEarlier(false);
      setHistoryOpen(false);
      followBottom();
    } catch (err) {
      if (mine !== loadSeqRef.current) return;
      // On failure keep the conversation and only show a banner; never replace the list with an error bubble
      setHistoryOpen(false);
      setLoadError(t('error.historyLoad', { message: errText(err) }));
    }
  };

  const loadEarlier = useCallback(async () => {
    if (!settings || !conversationId || !historyHasMore || !historyBefore || loadingEarlier || busy) return;
    const mine = loadSeqRef.current;
    const el = listRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    const prevTop = el?.scrollTop ?? 0;
    setLoadingEarlier(true);
    try {
      const conv = await getConversation(settings, conversationId, {
        limit: HISTORY_PAGE_SIZE,
        before: historyBefore,
      });
      if (mine !== loadSeqRef.current) return;
      const older = toMessages(conv.messages, page?.kind === 'pdf');
      preparePrepend();
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return [...older.filter((m) => !seen.has(m.id)), ...prev];
      });
      setHistoryHasMore(conv.hasMore === true);
      setHistoryBefore(conv.nextBefore ?? null);
      restorePrepend(prevHeight, prevTop);
    } catch (err) {
      cancelPrepend();
      if (mine === loadSeqRef.current) {
        setLoadError(t('error.historyLoad', { message: errText(err) }));
      }
    } finally {
      if (mine === loadSeqRef.current) setLoadingEarlier(false);
    }
  }, [
    settings,
    conversationId,
    historyHasMore,
    historyBefore,
    loadingEarlier,
    busy,
    page?.kind,
    preparePrepend,
    restorePrepend,
    cancelPrepend,
  ]);

  const removeConversation = async (id: string) => {
    if (!settings || busy) return;
    try {
      await deleteConversation(settings, id);
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (id === conversationId) {
        setConversationId(null);
        setMessages([]);
      }
      setLoadError(null);
    } catch (err) {
      // A failed delete likewise leaves the current conversation alone
      setLoadError(t('error.historyDelete', { message: errText(err) }));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // isComposing: Enter while an IME is composing candidates must not send
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      if (e.shiftKey) {
        e.preventDefault();
        // Use the native command to insert a line break: it maintains the trailing placeholder <br>,
        // so the first press already shows a blank line and arrow keys don't stick on zero-width chars.
        document.execCommand('insertLineBreak');
        setInput(serialize());
        return;
      }
      // While a run is streaming, plain Enter is a normal newline; only an idle editor sends.
      if (busy) return;
      e.preventDefault();
      if (canSend) void send();
    }
  };

  /**
   * Every keystroke re-serializes the uncontrolled editor into React state. Chromium leaves an
   * empty placeholder line (<br>, or a <div><br></div> block) behind after the last character is
   * deleted, which defeats the `.editor:empty` rule that shows the placeholder — so clear that
   * residue here. A blank line the user asked for with Shift+Enter is content, not residue.
   */
  const onInput = (e: React.FormEvent<HTMLDivElement>) => {
    const native = e.nativeEvent as InputEvent;
    if (!native.isComposing && native.inputType !== 'insertLineBreak' && native.inputType !== 'insertParagraph') {
      clearEmptyEditorResidue(editorRef.current);
    }
    setInput(serialize());
  };

  /**
   * An IME can swallow the final input event (or deliver it with isComposing still true) after
   * the last character is deleted, so onInput never cleans the leftover <br> and the placeholder
   * stays hidden. Re-check when composition ends, including the next frame for Chromium's final
   * composition input.
   */
  const onCompositionEnd = () => {
    clearEmptyEditorResidue(editorRef.current);
    setInput(serialize());
    requestAnimationFrame(() => {
      clearEmptyEditorResidue(editorRef.current);
      setInput(serialize());
    });
  };

  /**
   * Plain text pastes as text (external HTML never enters the editor); a clipboard of files attaches them,
   * and so does text past the paste-as-file threshold, once attaching is possible at all.
   */
  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n');
    const files = transferFiles(e.clipboardData);
    if (!text && files.length) {
      composerFiles.add(files);
      return;
    }
    const asFile = configured && pageState.kind === 'ready' ? pastedTextFile(settings, text) : null;
    if (asFile) {
      composerFiles.add([asFile]);
      return;
    }
    insertTextAtCaret(text);
  };

  /** Dragging text in would otherwise let the browser insert HTML (and remote <img> tags). */
  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!configured || pageState.kind !== 'ready') return;
    const files = transferFiles(e.dataTransfer);
    if (files.length) {
      composerFiles.add(files);
      return;
    }
    const text = e.dataTransfer.getData('text/plain').replace(/\r\n?/g, '\n');
    if (text) insertTextAtCaret(text);
  };

  /* ---------------- Miscellaneous ---------------- */

  const handleCopy = async () => {
    if (!page) return;
    try {
      await navigator.clipboard.writeText(page.markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      showToast(t('answer.copyFailed'));
    }
  };

  // Remember the caret inside the editor: the user clicks into the editor, then selects answer text
  // above, and that selection replaces the document selection, so the snapshot restores the spot.
  useEffect(() => {
    const onSel = () => {
      const el = editorRef.current;
      const sel = window.getSelection();
      if (!el || !sel || sel.rangeCount === 0) return;
      const r = sel.getRangeAt(0);
      if (el.contains(r.commonAncestorContainer)) savedRange.current = r.cloneRange();
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, []);
  useLayoutEffect(() => {
    const header = headerRef.current;
    const app = header?.parentElement;
    if (!header || !app) return;
    const measure = () => {
      // The floating overlay must start at the header's bottom edge, not 8px below: the page card
      // (and the error card) start right at header-bottom + gap, and fractional header heights
      // let their top border peek out above the backdrop as a hairline. The backdrop paints the
      // gap strip in the same --bg as the body, so extending it is seamless. The 8px standoff
      // still applies to the expanded box itself via composerSpace below.
      const headerBottom = header.offsetTop + header.offsetHeight;
      app.style.setProperty('--composer-top', `${headerBottom}px`);
      const height = Math.max(0, app.clientHeight - headerBottom - 8 - 12);
      const width = app.clientWidth;
      setComposerSpace((prev) => prev.height === height && prev.width === width ? prev : { height, width });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(app);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  // Measure natural text height before applying flex fill or interpolating the whole box. Expanded
  // mode never auto-collapses on short text — the button, send, and leaving the page collapse it.
  useLayoutEffect(() => {
    const el = editorRef.current;
    const box = el?.parentElement;
    const composer = box?.parentElement;
    if (!el || !box || !composer) return;
    const transition = composerTransitionRef.current;
    composerTransitionRef.current = null;
    const modeFrom = composerModeFromRef.current;
    composerModeFromRef.current = null;
    const from = transition?.height ?? modeFrom ?? box.getBoundingClientRect().height;
    const backdropFrom = transition?.backdrop ?? Number(composer.style.getPropertyValue('--composer-backdrop'));
    const scrollTop = el.scrollTop;
    box.style.height = '';
    box.style.overflow = '';
    el.style.flex = '0 0 auto';
    el.style.height = 'auto';
    const natural = el.scrollHeight;
    // Judge leaving multi mode at single-row width to avoid a wrap/un-wrap layout loop.
    let wraps = input.length > 0 && natural > SINGLE_LINE_H + 1;
    if (composerMultiRef.current && !wraps && input.length > 0) {
      el.style.width = `${el.offsetWidth - SINGLE_ROW_INSET}px`;
      wraps = el.scrollHeight > SINGLE_LINE_H + 1;
      el.style.width = '';
    }
    const multi = wraps || composerFiles.items.length > 0;
    const switched = multi !== composerMultiRef.current;
    if (switched) {
      composerMultiRef.current = multi;
      setComposerMulti(multi);
    }
    el.style.height = `${Math.min(natural, MAX_BOX_H)}px`;
    el.style.overflowY = natural > MAX_BOX_H ? 'auto' : 'hidden';
    const to = composerExpanded ? composerSpace.height : box.getBoundingClientRect().height;
    if (composerExpanded) {
      el.style.height = '0px';
      el.style.flex = '1 1 auto';
      el.style.overflowY = 'auto';
    }
    if (switched) {
      // Preserve the old height until React applies the new padding before paint.
      composerModeFromRef.current = from;
      box.style.height = `${from}px`;
      if (transition) composerTransitionRef.current = transition;
      el.scrollTop = scrollTop;
      return;
    }
    const expanding = composerExpandingRef.current;
    // A stale frame id means cleanup just canceled an in-flight animation (typing landed mid-way):
    // retarget it from the current height instead of snapping, or a key-held single↔multi switch
    // would jump, because every repeat keystroke re-runs this effect inside the 170ms window.
    const animating = growAnimRef.current !== 0;
    const finish = () => {
      growAnimRef.current = 0;
      composerExpandingRef.current = false;
      box.style.height = composerExpanded ? `${to}px` : '';
      box.style.overflow = '';
      el.style.flex = composerExpanded ? '1 1 auto' : '';
      el.scrollTop = scrollTop;
      composer.style.setProperty('--composer-backdrop', composerExpanded ? '1' : '0');
      if (!composerExpanded && composerFloating) {
        composer.style.height = '';
        setComposerFloating(false);
      }
    };
    if ((!expanding && !animating && modeFrom === null) || Math.abs(to - from) < 1) {
      finish();
      return;
    }
    box.style.overflow = 'hidden';
    box.style.height = `${from}px`;
    el.scrollTop = scrollTop;
    const started = performance.now();
    const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 170;
    const step = (now: number) => {
      const p = duration ? Math.max(0, Math.min(1, (now - started) / duration)) : 1;
      const eased = 1 - (1 - p) ** 3;
      box.style.height = `${from + (to - from) * eased}px`;
      if (expanding) {
        const backdropTo = composerExpanded ? 1 : 0;
        composer.style.setProperty('--composer-backdrop', `${backdropFrom + (backdropTo - backdropFrom) * eased}`);
      }
      if (p < 1) growAnimRef.current = requestAnimationFrame(step);
      else finish();
    };
    growAnimRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(growAnimRef.current);
  }, [input, pageState.kind, composerMulti, composerFiles.items.length, selectionHint, composerExpanded,
    composerFloating, composerSpace]);

  // Conversation title at top left, from the conversation list (the `title` event updates it in place)
  const currentTitle = useMemo(
    () => conversations.find((c) => c.id === conversationId)?.title ?? '',
    [conversations, conversationId],
  );

  // Group by turn: each turn's reasoning + tool calls collapse into one block
  const rounds = useMemo(() => buildRounds(messages), [messages]);

  return (
    <div className="app">
      <header ref={headerRef} className="hd">
        {/* Top left: current conversation title (auto-title writes it after the first answer; blank until then) */}
        <div className={`hd-title${titlePulse ? " in" : ""}`} title={currentTitle} onAnimationEnd={() => setTitlePulse(false)}>
          {currentTitle}
        </div>
        <div className="hd-right">
          <button
            className="ghost"
            onClick={newConversation}
            disabled={busy || messages.length === 0}
            title={t('header.newChat.title')}
          >
            {t('header.newChat')}
          </button>
          <button
            className={`ghost ${historyOpen ? 'on' : ''}`}
            onClick={toggleHistory}
            disabled={!pageUrl || busy}
            title={t('header.history.title')}
          >
            {conversations.length
              ? t('history.titleWithCount', { count: conversations.length })
              : t('header.history')}
          </button>
          <button
            className={`ghost ${settingsOpen ? 'on' : ''}`}
            onClick={() => {
              requestComposerExpanded(false);
              setSettingsOpen((v) => !v);
            }}
            title={t('header.settings.title')}
          >
            {t('header.settings')}
          </button>
          <button className="ghost" onClick={() => void load()} disabled={pageState.kind === 'loading'}>
            {pageState.kind === 'loading' ? '…' : t('header.reload')}
          </button>
        </div>
      </header>

      {settingsOpen && settings && (
        <SettingsPanel
          value={settings}
          showToast={showToast}
          onDone={(next) => {
            setLocale(resolveLocale(next.locale));
            setSettings(next);
            setSettingsOpen(false);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {historyOpen && (
        <HistoryPanel
          conversations={conversations}
          conversationId={conversationId}
          busy={busy}
          onOpen={(id) => void openConversation(id)}
          onDelete={(id) => void removeConversation(id)}
        />
      )}

      {/* Page card: one line by default so it doesn't crowd the conversation; not rendered in clean mode */}
      {pageState.kind === 'ready' && verbose && (
        <PageCard
          page={pageState.page}
          open={showPageText}
          copied={copied}
          onToggle={() => setShowPageText((v) => !v)}
          onCopy={() => void handleCopy()}
        />
      )}

      {pageState.kind === 'failed' && (
        <section className="card error">
          <div className="card-title">{t('page.failure.title')}</div>
          <p>{t(REASON_HINT[pageState.failure.reason])}</p>
          <pre className="raw">{pageState.failure.message}</pre>
        </section>
      )}

      {/* Conversation area */}
      <div className="list-wrap">
      <div
        className="list"
        ref={listRef}
        onScroll={handleListScroll}
        onWheel={noteUserScroll}
        onTouchMove={noteUserScroll}
        onPointerDown={noteUserScroll}
        onKeyDown={noteUserScroll}
      >
        <div ref={leadSpacerRef} className="scroll-lead" aria-hidden="true" />
        {loadError && (
          <div className="load-error" role="alert">
            <span>{loadError}</span>
            <button
              type="button"
              className="icon-btn"
              title={t('action.dismiss')}
              aria-label={t('action.dismiss')}
              onClick={() => setLoadError(null)}
            >
              ×
            </button>
          </div>
        )}
        {messages.length === 0 && (
          <div className="empty">
            <p className="muted">
              {pageState.kind === 'ready' ? t('empty.ready') : t('empty.notReady')}
            </p>
            {pageState.kind === 'ready' && (
              <div className="chips">
                {SUGGESTION_KEYS.map((key) => (
                  <button
                    key={key}
                    className="suggest"
                    onClick={() => void send(t(key))}
                    disabled={!configured || busy || composerFiles.uploading}
                  >
                    {t(key)}
                  </button>
                ))}
              </div>
            )}
            {messages.length === 0 && pageUrl && conversations.length > 0 && (
              <p className="muted small">{t('empty.hasHistory', { count: conversations.length })}</p>
            )}
          </div>
        )}

        {historyHasMore && (
          <div className="history-more">
            <button
              type="button"
              className="history-more-btn"
              disabled={loadingEarlier}
              onClick={() => void loadEarlier()}
            >
              {loadingEarlier ? t('history.loadingEarlier') : t('history.loadEarlier')}
            </button>
          </div>
        )}

        {rounds.map((r, roundIndex) => {
          const lastAnswerPhase = r.phases.reduce((acc, p, i) => (p.answers.length ? i : acc), -1);
          const actionPhase = lastAnswerPhase >= 0 ? r.phases[lastAnswerPhase] : undefined;
          const actionMessage = actionPhase?.answers[actionPhase.answers.length - 1];
          // Only the last turn can regenerate: the backend truncates after the last user message and reruns
          const isLastRound = roundIndex === rounds.length - 1;
          const actionsReady = actionMessage != null && !actionMessage.streaming && !(isLastRound && busy);
          // More than 3h since the previous turn ended → insert a time row above this question;
          // otherwise time only fades in at the bubble's left edge on hover (never shown twice).
          const userAt = r.user?.createdAt ?? null;
          const prevEnd = roundIndex > 0 ? roundEndAt(rounds[roundIndex - 1]!) : null;
          const showSep = userAt != null && (prevEnd == null || userAt - prevEnd > TIME_SEP_GAP_MS);
          const userMsg = r.user;
          // An attachment-only question has no bubble, just its cards
          const hasBubble = Boolean(userMsg?.content || userMsg?.selection);
          return (
          <div key={r.key} className="turn">
            {userMsg && (
              <>
                {showSep && <div className="time-sep">{fmtTime(userAt)}</div>}
                {editing?.localId === userMsg.id ? (
                  <div ref={editingUserRef} className="msg user editing">
                    <div className="inline-edit" onDragOver={(e) => e.preventDefault()} onDrop={onEditDrop}>
                      <AttachmentStrip
                        items={editFiles.items}
                        settings={settings}
                        onRemove={editFiles.remove}
                        onPreview={setPreview}
                      />
                      <div
                        ref={inlineEditorRef}
                        className="inline-edit-input"
                        contentEditable
                        role="textbox"
                        aria-multiline="true"
                        aria-label={t('question.edit')}
                        spellCheck={false}
                        onInput={onEditInput}
                        onKeyDown={onEditKeyDown}
                        onPaste={onEditPaste}
                      />
                      <div className="inline-edit-actions">
                        <AttachButton className="edit-attach" onFiles={editFiles.add} />
                        <button type="button" className="edit-cancel" onClick={cancelEdit}>
                          {t('question.edit.cancel')}
                        </button>
                        <button
                          type="button"
                          className="edit-send"
                          title={editFiles.uploading ? t('composer.uploading') : undefined}
                          disabled={(!editDraft.trim() && !editFiles.items.length) || editFiles.uploading || busy}
                          onClick={submitEdit}
                        >
                          {t('question.edit.send')}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div ref={isLastRound ? latestUserRef : undefined} className="msg user">
                    {userMsg.attachments && (
                      <div className="bubble-wrap att-wrap">
                        {!hasBubble && !showSep && userAt != null && (
                          <span className="msg-time">{fmtClock(userAt)}</span>
                        )}
                        <AttachmentStrip
                          items={sentCards(userMsg.attachments)}
                          settings={settings}
                          className="sent"
                          onPreview={setPreview}
                        />
                      </div>
                    )}
                    {/* Time outside the bubble follows its left edge (no drift when bubble widths differ) */}
                    {hasBubble && (
                      <div className="bubble-wrap">
                        {!showSep && userAt != null && <span className="msg-time">{fmtClock(userAt)}</span>}
                        <div className="bubble">
                          {userMsg.selection && (
                            <div
                              className="sel-hint"
                              role="note"
                              title={userMsg.selection}
                              aria-label={t('composer.selection.aria', { text: userMsg.selection })}
                            >
                              <IconQuoteMark className="sel-hint-mark" />
                              <span className="sel-hint-text">{userMsg.selection}</span>
                            </div>
                          )}
                          {renderUserText(userMsg.content)}
                        </div>
                      </div>
                    )}
                    {/* Same icon row as an answer's actions, mirrored to the bubble's right edge */}
                    <div className="msg-actions">
                      {userMsg.content && (
                        <button
                          type="button"
                          className="icon-btn"
                          title={copiedUserId === userMsg.id ? t('question.copied') : t('question.copy')}
                          aria-label={copiedUserId === userMsg.id ? t('question.copied') : t('question.copy')}
                          onClick={() => copyQuestion(userMsg)}
                        >
                          {copiedUserId === userMsg.id ? <IconCheck /> : <IconCopy />}
                        </button>
                      )}
                      <button
                        type="button"
                        className="icon-btn"
                        title={t('question.edit')}
                        aria-label={t('question.edit')}
                        disabled={busy}
                        onClick={() => startEdit(userMsg)}
                      >
                        <IconEdit />
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}

            {/* Each think/tool round has its own collapsible block, so reasoning/tools B never
                hide above answer A and each answer gets its own summary. */}
            {r.phases.map((p) => {
              // A tool can finish before the next upstream segment starts. Keep the block in its
              // "thinking" state during that gap instead of collapsing to a 0.0s summary.
              const waiting = !p.answered && (p.running || (isLastRound && busy));
              const active = waiting;
              return (
                <Fragment key={p.key}>
                  {verbose && (p.reasoning || p.steps.length > 0) && (
                    <RoundPanel
                      active={active}
                      summary={
                        active
                          ? t('round.running')
                          : p.steps.length > 0
                            ? t('round.both', { tools: p.steps.length, secs: seconds(p.processMs) })
                            : t('round.thinkOnly', { secs: seconds(p.processMs) })
                      }
                    >
                      {p.reasoning && <pre className="think-text">{p.reasoning}</pre>}
                      {p.steps.map((m) => (
                        <div key={m.id} className="step">
                          <span
                            className={`step-ico ${m.toolState === 'running' ? 'run' : m.toolOk === false ? 'bad' : 'ok'}`}
                          >
                            {m.toolState === 'running' ? '◌' : m.toolOk === false ? '!' : '✓'}
                          </span>
                          <span className="step-name">{m.toolLabel ?? t('tool.unknown')}</span>
                          {m.toolDetail && <span className="step-detail">{m.toolDetail}</span>}
                          {m.toolState === 'running' ? (
                            <span className="muted small">{t('tool.running')}</span>
                          ) : m.toolOk === false ? (
                            <span className="err small">{t('tool.failed')}</span>
                          ) : m.toolChars != null && !m.toolDetail && m.toolName !== 'screenshot' ? (
                            <span className="muted small">
                              {t('tool.chars', { count: m.toolChars.toLocaleString(getLocale()) })}
                            </span>
                          ) : null}
                        </div>
                      ))}
                    </RoundPanel>
                  )}

                  {/* Clean-mode placeholder is per phase: a new tool round fades in a fresh one */}
                  {!verbose && waiting && <ThinkingFade show={!p.answered} />}

                  {p.answers.map((m) => (
                    <div key={m.id} className="msg assistant">
                      <div className="answer" aria-live="polite" aria-busy={m.streaming || undefined}>
                        {m.content ? (
                          <div className={`md-wrap${m.streaming ? ' streaming' : ''}`}>
                            <MarkdownView
                              text={m.content}
                              streaming={m.streaming}
                              baseUrl={page?.url}
                              onQuoteMath={insertQuoteChip}
                              artifacts={settings && conversationId
                                ? { settings, conversationId, showToast, quoteFile: insertFileChip }
                                : undefined}
                            />
                          </div>
                        ) : null}
                        {m.error && <p className="err">{m.error}</p>}
                        {m.aborted && !m.streaming && <p className="muted small">{t('answer.truncated')}</p>}
                      </div>
                    </div>
                  ))}
                </Fragment>
              );
            })}
            {actionsReady && actionMessage && (
              <div className="answer-actions">
                <button
                  type="button"
                  className="icon-btn"
                  title={copiedId === actionMessage.id ? t('answer.copied') : t('answer.copy')}
                  aria-label={copiedId === actionMessage.id ? t('answer.copied') : t('answer.copy')}
                  onClick={() => copyRound(r, actionMessage.id)}
                >
                  {copiedId === actionMessage.id ? <IconCheck /> : <IconCopy />}
                </button>
                {isLastRound && conversationId && (
                  <button
                    type="button"
                    className="icon-btn"
                    title={t('answer.regenerate.title')}
                    aria-label={t('answer.regenerate')}
                    disabled={busy}
                    onClick={() => regenerateRound(r)}
                  >
                    <IconReload />
                  </button>
                )}
                {verbose && (actionMessage.ms != null || actionMessage.tokensOut != null) && (
                  <span className="meta foot">
                    {actionMessage.ms != null && <span>{(actionMessage.ms / 1000).toFixed(1)}s</span>}
                    {actionMessage.tokensOut != null && (
                      <span>
                        {t('answer.usage', { out: actionMessage.tokensOut, in: actionMessage.tokensIn ?? '?' })}
                      </span>
                    )}
                  </span>
                )}
              </div>
            )}
          </div>
          );
        })}
        {/* Scroll anchor: catches "taller than estimated" cases when pinned (table/KaTeX reflow) */}
        <div ref={listEndRef} className="list-end" />
        {/* Invisible breathing room controlled by the scroll layout effect (never rendered as content). */}
        <div ref={spacerRef} className="scroll-spacer" aria-hidden="true" />
      </div>
      {showScrollBtn && (
        <button
          type="button"
          className="scroll-bottom"
          title={t('scroll.toBottom')}
          aria-label={t('scroll.toBottom')}
          onClick={scrollToBottom}
        >
          <IconArrowDown />
        </button>
      )}
      </div>

      {/* Floating "Quote" button when answer text is selected */}
      {quoteMenu && (
        <button
          className="quote-btn"
          style={{ left: quoteMenu.left, top: quoteMenu.top }}
          title={t('quote.action.title')}
          aria-label={t('quote.action')}
          // preventDefault on mousedown keeps the selection alive so click still sees it
          onMouseDown={(e) => e.preventDefault()}
          onClick={applyQuote}
        >
          <IconQuote />
        </button>
      )}

      <Composer
        editorRef={editorRef}
        settings={settings}
        configured={configured}
        pageReady={pageState.kind === 'ready'}
        busy={busy}
        canSend={canSend}
        multiline={composerMulti}
        expanded={composerExpanded}
        floating={composerFloating}
        onToggleExpanded={() => {
          requestComposerExpanded(!composerExpanded);
          editorRef.current?.focus();
        }}
        attachments={composerFiles.items}
        uploading={composerFiles.uploading}
        selectionHint={selectionHint}
        onInput={onInput}
        onCompositionEnd={onCompositionEnd}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onDrop={onDrop}
        onAttach={composerFiles.add}
        onRemoveAttachment={composerFiles.remove}
        onPreview={setPreview}
        onSend={() => void send()}
        onExplainSelection={() => void send(t('composer.selection.explainPrompt'))}
        onStop={stop}
      />

      {preview && <ImageLightbox target={preview} onClose={closePreview} />}

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}



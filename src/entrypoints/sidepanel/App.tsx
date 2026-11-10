import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MarkdownView } from '@/components/MarkdownView';
import { IconArrowDown, IconCheck, IconCopy, IconEdit, IconQuote, IconReload } from '@/components/icons';
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
import {
  DEFAULT_SETTINGS,
  isConfigured,
  loadSettings,
  normalizeUrl,
  type Settings,
} from '@/lib/settings';
import { SettingsPanel } from './SettingsPanel';
import { Composer } from './Composer';
import { HistoryPanel } from './HistoryPanel';
import { PageCard } from './PageCard';
import { RoundPanel, ThinkingFade } from './RoundPanel';
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
  serializeEditor,
  syncEditorEmptyState,
} from './editorDom';

/** Editor max height (beyond this it scrolls internally); must match .editor max-height in style.css */
const MAX_BOX_H = 156;
/** Messages per history page; the backend clamps to 500 */
const HISTORY_PAGE_SIZE = 200;

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

/** Render <q>…</q> fragments in user bubbles as inline quotes; everything else stays plain text */
function renderUserText(content: string) {
  return content.split(/(<q>[\s\S]*?<\/q>)/g).map((part, i) =>
    part.startsWith('<q>') && part.endsWith('</q>') ? (
      <span className="bubble-q" key={i}>
        {decodeQuote(part.slice(3, -4))}
      </span>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
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
  /** Page selection shown on the editor's first line (hint only; send carries its own selection context) */
  const [selectionHint, setSelectionHint] = useState('');
  /** Floating "Quote" button when answer text is selected (viewport coords + the selected source text) */
  const [quoteMenu, setQuoteMenu] = useState<{ left: number; top: number; text: string } | null>(null);

  const seq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  /** Synchronous "sending" gate: busy is state, so a double click passes twice before the re-render */
  const sendingRef = useRef(false);
  /** Bumped on every send; a late finally must not clear the next run's busy state */
  const runSeqRef = useRef(0);
  /** PDF reads need the backend URL + token, but load() must stay stable, so keep them in refs */
  const backendRef = useRef<string>(DEFAULT_SETTINGS.backendUrl);
  const tokenRef = useRef<string>('');
  const listRef = useRef<HTMLDivElement | null>(null);

  const editorRef = useRef<HTMLDivElement | null>(null);
  /** Inline question editor (rendered in place of a user bubble); kept uncontrolled like the composer */
  const inlineEditorRef = useRef<HTMLDivElement | null>(null);
  /** Last caret inside the editor: selecting elsewhere replaces the document selection; restore this */
  const savedRange = useRef<Range | null>(null);
  const stickToBottom = useRef(true);
  // Mirrors "not following" for the floating jump-to-bottom button. Kept separate from the ref so
  // layout/animation code can change the scroll behavior without forcing a React render.
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  /** Async callbacks must ask "did the user already send?", and only a ref holds the latest value */
  const messagesRef = useRef<Message[]>([]);
  /** Conversation load sequence: on tab switches or rapid history clicks only the latest request wins */
  const loadSeqRef = useRef(0);
  /** When the current page snapshot was read; sending refreshes stale SPA content */
  const pageLoadedAtRef = useRef(0);
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
  const pageUrl = page?.url ?? null;
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
    const next = !historyOpen;
    setHistoryOpen(next);
    // Opening the panel is also a retry: a backend that was down when the tab loaded may be back now.
    if (next && pageUrl && settings) void refreshConversations(pageUrl, settings);
  }, [historyOpen, pageUrl, settings, refreshConversations]);

  /* ---------------- Page loading ---------------- */

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setPageState({ kind: 'loading' });
    const result = await readActiveTab({ backendUrl: backendRef.current, token: tokenRef.current });
    if (mine !== seq.current) return; // a newer read started; drop this result
    if (result.ok) {
      pageLoadedAtRef.current = Date.now();
      // Key conversations by URL without #hash: anchors of one article must not become two conversations
      setPageState({ kind: 'ready', page: { ...result.page, url: normalizeUrl(result.page.url) } });
    } else {
      setPageState({ kind: 'failed', failure: result });
    }
    setShowPageText(false);
  }, []);

  useEffect(() => {
    // Wait for stored settings: a PDF needs the backend token, and loading once with an empty token
    // would show a 401 until the next tab event. Re-running on token changes also picks up a new token.
    if (!settings) return;
    void load();
    const onActivated = () => void load();
    const onUpdated = (_id: number, info: { status?: string; url?: string }, tab: { active?: boolean }) => {
      if (!tab.active) return;
      if (info.status !== 'complete' && !info.url) return;
      void load();
    };
    browser.tabs.onActivated.addListener(onActivated);
    browser.tabs.onUpdated.addListener(onUpdated);
    return () => {
      browser.tabs.onActivated.removeListener(onActivated);
      browser.tabs.onUpdated.removeListener(onUpdated);
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
  }, [pageState, configured]);

  useEffect(() => {
    void loadSettings().then((next) => {
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
      suppressedResumeUrl.current = null;
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
    if (suppressedResumeUrl.current && suppressedResumeUrl.current !== pageUrl) suppressedResumeUrl.current = null;
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
        if (!editorHasDraft()) {
          const recovered = await recoverPendingQuestion(settings, conv.id).catch(() => null);
          if (cancelled || mine !== loadSeqRef.current) return;
          if (sendingRef.current || messagesRef.current.length > 0) return;
          if (recovered) {
            stored = stored.filter((m) => m.id !== recovered.messageId);
            fillEditor(recovered.text);
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
  }, [pageUrl, settings?.backendUrl, refreshConversations, fillEditor, editorHasDraft, page?.kind]);

  /* ---------------- Scrolling ---------------- */

  const scrollConversation = useRef<string | null>(null);
  // Bottom spacer: gives the sent question room to sit in the middle of the viewport, and absorbs
  // answer growth / think-block collapse so the viewport does not move until the spacer is gone.
  const spacerRef = useRef<HTMLDivElement | null>(null);
  const spacerHeight = useRef(0);
  const contentHeight = useRef(0);
  // A one-shot spacer above the first message: it lets a brand-new conversation start with the
  // question at the bottom, then shrink away so the question slides up to its final place at the top.
  const leadSpacerRef = useRef<HTMLDivElement | null>(null);
  const leadHeight = useRef(0);
  const leadAnim = useRef<number | null>(null);
  const centerNext = useRef(false);
  const prepended = useRef(false);
  // A new conversation gets its id from the server's `meta` after the messages are already rendered.
  // That id change must not look like a conversation switch (which would reset the spacer and pin
  // to the bottom, undoing the centering).
  const pendingConversation = useRef(false);
  const internalScrollUntil = useRef(0);
  // Layout-induced scroll events (browser scroll clamping, scrollbar appearing) must not look like
  // the user scrolling up. Only wheel/touch/pointer input arms the brake in onScroll.
  const userScrollAt = useRef(0);
  // Right after a send the question is centered; hold that offset until the turn ends. A think
  // block collapsing (instant, or 240ms in clean mode) can otherwise make the browser clamp the
  // scroll offset before the spacer has grown to cover the removed height.
  const centerLockTop = useRef(0);
  const centerLockUntil = useRef(0);
  const scrollAnim = useRef<{ frame: number; until: number } | null>(null);

  const cancelScrollAnim = () => {
    if (!scrollAnim.current) return;
    cancelAnimationFrame(scrollAnim.current.frame);
    scrollAnim.current = null;
  };

  const applySpacer = (px: number) => {
    const max = listRef.current?.clientHeight ?? 0;
    const next = Math.max(0, Math.min(max, Math.round(px)));
    spacerHeight.current = next;
    if (spacerRef.current) spacerRef.current.style.height = `${next}px`;
  };

  const cancelLeadAnim = () => {
    if (leadAnim.current == null) return;
    cancelAnimationFrame(leadAnim.current);
    leadAnim.current = null;
  };

  const applyLead = (px: number) => {
    const max = listRef.current?.clientHeight ?? 0;
    const next = Math.max(0, Math.min(max, Math.round(px)));
    leadHeight.current = next;
    if (leadSpacerRef.current) leadSpacerRef.current.style.height = `${next}px`;
  };

  const scrollTo = (el: HTMLElement, top: number) => {
    cancelScrollAnim();
    // Programmatic scrolls must not run the user-scroll brake in onScroll.
    internalScrollUntil.current = performance.now() + 120;
    el.scrollTop = top;
  };

  // Ease-in-out cubic: slow at both ends, fast in the middle. A native smooth scroll has no easing
  // control, so the centering slide is driven by rAF and can be cancelled the moment the user scrolls.
  const animateScrollTo = (el: HTMLElement, top: number) => {
    cancelScrollAnim();
    const from = el.scrollTop;
    const delta = top - from;
    const duration = 460;
    if (Math.abs(delta) < 2 || window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
      scrollTo(el, top);
      return;
    }
    const start = performance.now();
    internalScrollUntil.current = start + duration + 120;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      el.scrollTop = from + delta * eased;
      if (t < 1) {
        scrollAnim.current = { frame: requestAnimationFrame(tick), until: start + duration };
      } else {
        scrollAnim.current = null;
        internalScrollUntil.current = performance.now() + 120;
      }
    };
    scrollAnim.current = { frame: requestAnimationFrame(tick), until: start + duration };
  };

  const scrollToBottom = () => {
    const el = listRef.current;
    if (!el) return;
    // A click is an explicit request to resume following: drop the blank room below the content,
    // clear the centering hold, then slide to the real bottom.
    centerLockUntil.current = 0;
    applySpacer(0);
    contentHeight.current = el.scrollHeight;
    stickToBottom.current = true;
    setShowScrollBtn(false);
    animateScrollTo(el, el.scrollHeight);
  };

  /**
   * Track the real content bottom, not the blank spacer. A centered send leaves the spacer below the
   * question, so a plain scrollHeight check would reveal the button immediately; `.list-end` is the
   * zero-height sentinel after the last turn, which only passes the viewport once the answer itself
   * has grown past it.
   */
  const refreshScrollBtn = (el: HTMLElement) => {
    const end = el.querySelector<HTMLElement>('.list-end');
    if (!end) return;
    const gap = end.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom;
    setShowScrollBtn(gap > 1);
  };

  const animateLeadTo = (el: HTMLElement, top: number) => {
    cancelLeadAnim();
    const from = leadHeight.current;
    if (Math.abs(top - from) < 2) {
      applyLead(top);
      return;
    }
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
      applyLead(top);
      contentHeight.current = el.scrollHeight - spacerHeight.current;
      return;
    }
    const duration = 460;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      applyLead(from + (top - from) * eased);
      // The lead is part of the content box; keep the delta tracker in sync while it shrinks.
      contentHeight.current = el.scrollHeight - spacerHeight.current;
      if (t < 1) {
        leadAnim.current = requestAnimationFrame(tick);
      } else {
        leadAnim.current = null;
        applyLead(top);
        contentHeight.current = el.scrollHeight - spacerHeight.current;
      }
    };
    leadAnim.current = requestAnimationFrame(tick);
  };

  // useLayoutEffect, not useEffect: every adjustment lands before paint, so a collapse never shows
  // the old scroll offset for one frame.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const key = conversationId ?? '';
    const reset = scrollConversation.current !== key;
    scrollConversation.current = key;

    if (reset) {
      cancelLeadAnim();
      applyLead(0);
      applySpacer(0);
      contentHeight.current = el.scrollHeight;
      stickToBottom.current = true;
      setShowScrollBtn(false);
      centerNext.current = false;
      pendingConversation.current = false;
      scrollTo(el, el.scrollHeight);
      return;
    }

    if (prepended.current) {
      // loadEarlier already restores the old scrollTop; its growth is above the viewport.
      prepended.current = false;
      contentHeight.current = el.scrollHeight - spacerHeight.current;
      return;
    }

    if (leadAnim.current != null) {
      // The lead spacer is animated frame by frame; its height change is not content growth.
      contentHeight.current = el.scrollHeight - spacerHeight.current;
      return;
    }

    if (centerNext.current) {
      centerNext.current = false;
      applySpacer(0);
      const users = el.querySelectorAll<HTMLElement>('.msg.user');
      const userEl = users[users.length - 1];
      if (!userEl) {
        contentHeight.current = el.scrollHeight;
        return;
      }
      const listRect = el.getBoundingClientRect();
      const userRect = userEl.getBoundingClientRect();
      const userTop = userRect.top - listRect.top + el.scrollTop;
      stickToBottom.current = false;
      if (users.length === 1) {
        // No previous content to scroll above: put the first question at the bottom with a
        // temporary lead spacer, then shrink that spacer so the question glides up to the top.
        const lead = Math.max(0, el.clientHeight - userRect.height - userTop);
        cancelLeadAnim();
        applyLead(lead);
        contentHeight.current = el.scrollHeight - spacerHeight.current;
        scrollTo(el, 0);
        centerLockUntil.current = 0;
        animateLeadTo(el, 0);
        return;
      }
      cancelLeadAnim();
      applyLead(0);
      const target = Math.max(0, userTop + userRect.height / 2 - el.clientHeight / 2);
      applySpacer(target + el.clientHeight - el.scrollHeight);
      contentHeight.current = el.scrollHeight - spacerHeight.current;
      // Start from the current bottom position and slide the new question to the middle.
      animateScrollTo(el, target);
      // Hold the question centered until the turn ends: any layout clamp while the think block
      // mounts/collapses must not move the viewport (or look like a user scroll to onScroll).
      centerLockTop.current = target;
      centerLockUntil.current = performance.now() + 30_000;
      refreshScrollBtn(el);
      return;
    }

    const height = el.scrollHeight - spacerHeight.current;
    const delta = height - contentHeight.current;
    contentHeight.current = height;
    if (delta > 0) {
      // Answer growth first consumes the blank spacer; the total height stays put.
      if (spacerHeight.current > 0) applySpacer(spacerHeight.current - delta);
    } else if (delta < 0 && !(stickToBottom.current && spacerHeight.current <= 0)) {
      // A think block collapsed while not following: give the space back to the spacer instead of
      // moving the viewport. When following, skip this and let the pin below absorb the shrink.
      applySpacer(spacerHeight.current - delta);
    }

    const now = performance.now();
    if (scrollAnim.current && now < scrollAnim.current.until) return;
    if (centerLockUntil.current > now) {
      // The collapse can clamp scrollTop before the spacer has caught up. While the centering lock
      // is held, make the centered offset reachable again and restore it in this layout pass, so
      // the clamp is never painted.
      const need = centerLockTop.current + el.clientHeight - el.scrollHeight;
      if (need > 0) applySpacer(spacerHeight.current + need);
      const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
      const want = Math.min(centerLockTop.current, maxTop);
      if (Math.abs(el.scrollTop - want) > 1) scrollTo(el, want);
      refreshScrollBtn(el);
      return;
    }

    if (stickToBottom.current && spacerHeight.current <= 0) {
      scrollTo(el, el.scrollHeight);
    }
    refreshScrollBtn(el);
  }, [messages, conversationId]);

  // CSS height transitions (ThinkingFade) and late images change the layout without a React render.
  // Compensate them with the spacer too; otherwise the 240ms collapse still drags the viewport up.
  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (leadAnim.current != null) {
        // The lead animation owns layout while it runs; do not reinterpret its shrink as content.
        contentHeight.current = el.scrollHeight - spacerHeight.current;
        return;
      }
      // The panel can be resized; never let the spacer protrude past the new viewport.
      if (spacerHeight.current > el.clientHeight) applySpacer(el.clientHeight);
      const height = el.scrollHeight - spacerHeight.current;
      const delta = height - contentHeight.current;
      contentHeight.current = height;
      if (delta > 0) {
        if (spacerHeight.current > 0) applySpacer(spacerHeight.current - delta);
      } else if (delta < 0 && !(stickToBottom.current && spacerHeight.current <= 0)) {
        applySpacer(spacerHeight.current - delta);
      }

      const now = performance.now();
      if (scrollAnim.current && now < scrollAnim.current.until) return;
      if (centerLockUntil.current > now) {
        const need = centerLockTop.current + el.clientHeight - el.scrollHeight;
        if (need > 0) applySpacer(spacerHeight.current + need);
        const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
        const want = Math.min(centerLockTop.current, maxTop);
        if (Math.abs(el.scrollTop - want) > 1) scrollTo(el, want);
        refreshScrollBtn(el);
        return;
      }

      if (stickToBottom.current && spacerHeight.current <= 0) {
        scrollTo(el, el.scrollHeight);
      }
      refreshScrollBtn(el);
    });
    // The scroll container's own box is fixed, so observing it never fires. Watch each direct child
    // instead; MutationObserver keeps the set in sync as rounds/tool rows are added.
    const seen = new WeakSet<Element>();
    const sync = () => {
      for (const child of Array.from(el.children)) {
        if (seen.has(child)) continue;
        seen.add(child);
        ro.observe(child);
      }
    };
    sync();
    ro.observe(el);
    const mo = new MutationObserver(sync);
    mo.observe(el, { childList: true });
    return () => {
      mo.disconnect();
      ro.disconnect();
    };
  }, []);

  const noteUserScroll = () => {
    cancelScrollAnim();
    internalScrollUntil.current = 0;
    userScrollAt.current = performance.now();
    centerLockUntil.current = 0;
  };

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    // Scrolling moves the selection rect, so just dismiss the quote button
    setQuoteMenu(null);
    const now = performance.now();
    // Ignore the scroll events produced by our own centering animation; they would otherwise look
    // like a user taking control and cancel the lock mid-slide.
    if (scrollAnim.current && now < scrollAnim.current.until) return;
    if (centerLockUntil.current > now) {
      // The collapse may have made the centered offset unreachable; grow the spacer before
      // clamping so restoring the target cannot be silently truncated.
      const need = centerLockTop.current + el.clientHeight - el.scrollHeight;
      if (need > 0) applySpacer(spacerHeight.current + need);
      const want = Math.min(centerLockTop.current, Math.max(0, el.scrollHeight - el.clientHeight));
      centerLockTop.current = want;
      if (Math.abs(el.scrollTop - want) > 1) {
        internalScrollUntil.current = now + 120;
        el.scrollTop = want;
      }
      return;
    }
    if (now < internalScrollUntil.current) return;
    // Ignore scroll events we did not cause: a collapsing/expanding block can make the browser
    // clamp the offset, and treating that as "user scrolled up" shrinks the spacer and moves the
    // conversation. Only genuine wheel/touch/pointer input arms the brake below.
    if (now - userScrollAt.current > 400) return;

    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (gap > 1 && spacerHeight.current > 0) {
      // User is scrolling up: spend the blank spacer instead of moving the content. Shrinking it
      // by exactly the gap makes the content bottom touch the viewport bottom again, so the wheel
      // cannot run into blank space above the answer.
      applySpacer(spacerHeight.current - gap);
      stickToBottom.current = false;
      refreshScrollBtn(el);
      return;
    }
    // Following resumes only at the real bottom, never on a small upward nudge.
    if (gap <= 1 && spacerHeight.current <= 0) {
      stickToBottom.current = true;
    } else if (gap > 1) {
      stickToBottom.current = false;
    }
    refreshScrollBtn(el);
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

  /** Used for plain-text paste; line breaks are left to Shift+Enter's native command */
  const insertTextAtCaret = useCallback((text: string) => {
    const el = editorRef.current;
    if (!el) return;
    insertTextInto(el, text, savedRange.current);
    setInput(serialize());
  }, [serialize]);

  /** Insert a quote chip at the caret: contenteditable=false, so editing treats it as one character */
  const insertQuoteChip = (text: string) => {
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

    const chip = createQuoteChip(text);

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
  };

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

  const canSend = configured && !busy && input.trim().length > 0;

  const send = useCallback(
    async (raw?: string, opts?: { regenerate?: boolean; editMessageId?: string; editLocalId?: string }) => {
      const editMessageId = opts?.editMessageId;
      const editingQuestion = Boolean(editMessageId);
      const regenerate = Boolean(opts?.regenerate) && !editingQuestion;
      const question = (raw ?? serialize()).trim();
      if (!question || !settings || busy || sendingRef.current) return;
      if (!isConfigured(settings) || !page) return;
      if ((regenerate || editingQuestion) && !conversationId) return;
      if (editingQuestion && !opts?.editLocalId) return;

      const runId = ++runSeqRef.current;
      abortRef.current?.abort();
      sendingRef.current = true;
      suppressedResumeUrl.current = null;
      if (!regenerate && !editingQuestion) {
        setInput('');
        if (editorRef.current) {
          editorRef.current.innerHTML = '';
          syncEditorEmptyState(editorRef.current);
        }
        savedRange.current = null;
      }
      // Send starts a new scroll layout: center the question, leave blank space below, and stop
      // following until the user explicitly scrolls to the bottom again.
      stickToBottom.current = false;
      setShowScrollBtn(false);
      centerNext.current = !regenerate && !editingQuestion;
      if (editingQuestion) {
        // An edited question keeps the position it had when Send was clicked (unlike a new question,
        // which is centered). Sending deletes the later rows, so freeze the offset before that
        // layout change; the spacer below then fills the space they leave instead of pinning/clamping.
        centerLockTop.current = listRef.current?.scrollTop ?? 0;
        centerLockUntil.current = performance.now() + 30_000;
      }
      if (!conversationId) pendingConversation.current = true;

      // One question can produce several assistant segments (tool calls split them), so targetId
      // points at the bubble currently receiving text; it resets when a tool starts and recreates later.
      let targetId: string | null = crypto.randomUUID();
      const firstAsstId = targetId;
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
              createdAt: Date.now(),
            },
            { id: firstAsstId, role: 'assistant', content: '', reasoning: '', streaming: true },
          ];
        }
        return [
          ...prev,
          ...(localUserId
            ? [{ id: localUserId, role: 'user' as const, content: question, createdAt: Date.now() }]
            : []),
          { id: firstAsstId, role: 'assistant', content: '', reasoning: '', streaming: true },
        ];
      });

      const controller = new AbortController();
      abortRef.current = controller;
      setBusy(true);

      // setState per token makes Markdown/KaTeX reflow over and over, so buffer for 50ms and
      // flush into state in one go.
      let contentBuf = '';
      let reasoningBuf = '';
      // The server sends processMs on the first content/replace frame of each phase. Keep the
      // latest one so the live summary renders the same duration the persisted row will get.
      let phaseMs: number | null = null;
      /** The current phase already rendered answer text, so the next tool starts a new phase. */
      let phaseAnswered = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const flush = () => {
        timer = null;
        if (!contentBuf && !reasoningBuf) return;
        const c = contentBuf;
        const r = reasoningBuf;
        contentBuf = '';
        reasoningBuf = '';
        const id = targetId;
        if (!id) return;
        const livePhaseMs = phaseMs;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === id
              ? {
                  ...m,
                  content: m.content + c,
                  reasoning: (m.reasoning ?? '') + r,
                  ...(livePhaseMs != null ? { processMs: m.processMs ?? livePhaseMs } : {}),
                }
              : m,
          ),
        );
      };
      const schedule = () => {
        if (timer) return;
        timer = setTimeout(flush, 50);
      };
      /** Text after a tool finishes opens a new assistant bubble */
      const ensureTarget = () => {
        if (targetId) return;
        const id = crypto.randomUUID();
        targetId = id;
        setMessages((prev) => [...prev, { id, role: 'assistant', content: '', reasoning: '', streaming: true }]);
      };

      let convId = conversationId;
      /** The server ends a turn with done; a stream that closes without done is not a success */
      let sawDone = false;
      /** The server already sent error: don't overwrite it with a generic "connection lost" at cleanup */
      let sawError = false;

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
          if (fresh?.ok && normalizeUrl(fresh.page.url) === page.url) {
            snapshot = { ...fresh.page, url: page.url, selection: page.selection };
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
        const selected = sel?.text || snapshot.selection || '';

        for await (const ev of streamChat({
          settings,
          conversationId,
          page: {
            url: snapshot.url,
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
          if (ev.type === 'meta') {
            convId = ev.conversationId;
            if (pendingConversation.current) {
              // Assigning the new id is not a conversation switch; keep the centered layout.
              scrollConversation.current = ev.conversationId;
              pendingConversation.current = false;
            }
            // Remember which DB row this local bubble is, so editing it later targets the server id.
            if (localUserId) {
              const uid = localUserId;
              setMessages((prev) =>
                prev.map((m) => (m.id === uid ? { ...m, serverId: ev.messageId } : m)),
              );
            }
            setConversationId(ev.conversationId);
          } else if (ev.type === 'content') {
            // Keep the centering lock until done: the think block collapses in this commit and,
            // in clean mode, fades out for another 240ms. Releasing the lock here let a browser
            // scroll clamp move the question before the spacer had caught up.
            if (ev.processMs != null) phaseMs = ev.processMs;
            phaseAnswered = true;
            ensureTarget();
            contentBuf += ev.delta;
            schedule();
          } else if (ev.type === 'replace') {
            // Final output differs from the streamed deltas. Set the final text directly: flush()
            // appends, so buffering ev.text there would duplicate the already-rendered prefix.
            ensureTarget();
            if (ev.processMs != null) phaseMs = ev.processMs;
            phaseAnswered = true;
            const answerPhaseMs = phaseMs;
            if (timer) {
              clearTimeout(timer);
              timer = null;
            }
            const pendingReasoning = reasoningBuf;
            contentBuf = '';
            reasoningBuf = '';
            setMessages((prev) =>
              prev.map((m) =>
                m.id === targetId
                  ? {
                      ...m,
                      content: ev.text,
                      reasoning: (m.reasoning ?? '') + pendingReasoning,
                      processMs: m.processMs ?? answerPhaseMs ?? undefined,
                    }
                  : m,
              ),
            );
          } else if (ev.type === 'reasoning') {
            ensureTarget();
            reasoningBuf += ev.delta;
            schedule();
          } else if (ev.type === 'usage') {
            setMessages((prev) => prev.map((m) => (m.id === targetId ? { ...m, usage: ev.usage } : m)));
          } else if (ev.type === 'tool') {
            if (ev.phase === 'start') {
              flush();
              // Only a tool after answer text begins a new phase. A tool before any answer (e.g.
              // reasoning -> tool) is still the same think/tool phase, so keep its original clock.
              const startsNewPhase = phaseAnswered;
              // Close the segment that just answered: without this its streaming opacity/typing state
              // survives into the next think/tool phase and the fade appears stuck on answer A.
              if (targetId) {
                const doneTarget = targetId;
                setMessages((prev) =>
                  prev.map((m) => (m.id === doneTarget ? { ...m, streaming: false } : m)),
                );
              }
              // A new answer segment starts after the tool: measure its own phase from the tool start.
              if (startsNewPhase) {
                phaseMs = null;
                phaseAnswered = false;
              }
              targetId = null;
              setMessages((prev) => [
                ...prev,
                {
                  id: ev.id,
                  role: 'tool',
                  content: '',
                  toolName: ev.name,
                  toolLabel: toolLabel(ev.name, page?.kind === 'pdf'),
                  toolDetail: toolDetail(ev.name, ev.args ?? null),
                  toolArgs: ev.args,
                  toolState: 'running',
                },
              ]);
            } else {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === ev.id
                    ? {
                        ...m,
                        toolState: 'done',
                        toolOk: ev.ok !== false,
                        toolChars: ev.chars,
                        // The server's label/detail are more accurate (e.g. "638 chars in the viewport")
                        toolLabel: ev.label || m.toolLabel,
                        toolDetail: ev.detail || m.toolDetail,
                      }
                    : m,
                ),
              );
            }
          } else if (ev.type === 'done') {
            centerLockUntil.current = 0;
            sawDone = true;
            flush();
            // Answer done: release the editor now instead of holding the connection ~20s for auto-title
            if (runSeqRef.current === runId) {
              sendingRef.current = false;
              setBusy(false);
            }
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== targetId) return m.streaming ? { ...m, streaming: false } : m;
                return {
                  ...m,
                  streaming: false,
                  ms: ev.message?.ms ?? ev.ms,
                  processMs: ev.message?.processMs ?? m.processMs,
                  aborted: ev.aborted === true || m.aborted,
                  tokensIn: ev.message?.tokensIn ?? ev.totals?.tokensIn ?? m.tokensIn,
                  tokensOut: ev.message?.tokensOut ?? ev.totals?.tokensOut ?? m.tokensOut,
                  usage: ev.usage ?? m.usage,
                };
              }),
            );
          } else if (ev.type === 'error') {
            centerLockUntil.current = 0;
            sawError = true;
            flush();
            ensureTarget();
            const text = serverErrorText(ev.code, ev.params, ev.message);
            setMessages((prev) =>
              prev.map((m) => (m.id === targetId ? { ...m, streaming: false, error: text } : m)),
            );
          }
        }
        if (runSeqRef.current === runId && !sawDone && !sawError) {
          if (controller.signal.aborted) {
            // Stopped before headers arrived: streamChat returns silently, so wipe the empty bubble here
            setMessages((prev) =>
              prev
                .filter((m) => m.id !== targetId || m.content || m.reasoning)
                .map((m) => (m.streaming ? { ...m, streaming: false } : m)),
            );
          } else {
            // Stream closed without done: the answer may be half-written, so finish as an error
            throw new Error(t('error.streamCut'));
          }
        }
      } catch (err) {
        if (runSeqRef.current !== runId) return;
        flush();
        // After done only auto-title/connection teardown remain; a cut there doesn't affect the full answer
        if (sawDone || sawError) return;
        const stopped = controller.signal.aborted;
        setMessages((prev) => {
          // Stopped before any text was produced: don't leave an empty bubble behind
          const cleaned = prev.filter((m) => m.role !== 'tool' || m.toolState === 'done');
          const hasTarget = cleaned.some((m) => m.id === targetId);
          if (!hasTarget) {
            return cleaned.map((m) => (m.streaming ? { ...m, streaming: false } : m));
          }
          return cleaned.map((m) =>
            m.id === targetId
              ? {
                  ...m,
                  streaming: false,
                  error: stopped ? (m.content ? t('answer.stopped') : t('answer.stoppedEmpty')) : errText(err),
                }
              : m.streaming
                ? { ...m, streaming: false }
                : m,
          );
        });
      } finally {
        if (timer) clearTimeout(timer);
        // When a new run already started, a late cleanup must not clear its busy flag/gate
        if (runSeqRef.current === runId) {
          abortRef.current = null;
          sendingRef.current = false;
          setBusy(false);
          if (convId) void refreshConversations(page.url, settings);
        }
      }
    },
    [busy, conversationId, input, page, refreshConversations, serialize, settings],
  );

  const [copiedId, setCopiedId] = useState<string | null>(null);
  /** Separate from copiedId: a question and an answer are different buttons in the same turn */
  const [copiedUserId, setCopiedUserId] = useState<string | null>(null);
  /**
   * In-place question editor. `localId` keeps the rendered row stable while `serverId` is the DB id
   * the backend rewrites; `content` is the original text restored by fillEditor on open.
   */
  const [editing, setEditing] = useState<{ localId: string; serverId: string; content: string } | null>(null);
  /** Mirror of the inline editor's text: only used to disable Send while it is empty */
  const [editDraft, setEditDraft] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current != null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  }, []);

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
  }, [editing]);

  // The inline editor is taller than the bubble it replaces. Show all of it (scrolling only the
  // overflow) without pinning the list to the bottom; the send lock captures this offset later.
  // No center lock here: it would fight the browser scrolling the caret into view while typing.
  useLayoutEffect(() => {
    if (!editing) return;
    const el = listRef.current;
    const row = el?.querySelector<HTMLElement>('.msg.user.editing');
    if (!el || !row) return;
    cancelScrollAnim();
    stickToBottom.current = false;
    const listRect = el.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    let top = el.scrollTop + Math.max(0, rowRect.bottom - listRect.bottom);
    const need = top + el.clientHeight - el.scrollHeight;
    if (need > 0) applySpacer(spacerHeight.current + need);
    top = Math.min(top, Math.max(0, el.scrollHeight - el.clientHeight));
    scrollTo(el, top);
    refreshScrollBtn(el);
    contentHeight.current = el.scrollHeight - spacerHeight.current;
  }, [editing]);

  // A different page or conversation invalidates the open editor (its row may no longer exist).
  useEffect(() => {
    centerLockUntil.current = 0;
    setEditing(null);
    setEditDraft('');
  }, [conversationId, pageUrl]);

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
   * Copy the user's own question. Quote chips are serialized as <q>…</q> in the stored text, so
   * turn them back into plain quoted text instead of leaking the markers into the clipboard.
   */
  const copyQuestion = useCallback((m: Message) => {
    const text = m.content.replace(/<q>([\s\S]*?)<\/q>/g, (_all, quote: string) => `"${decodeQuote(quote)}"`);
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
      centerLockUntil.current = 0;
      setEditing({ localId: m.id, serverId: m.serverId ?? m.id, content: m.content });
      setEditDraft(m.content);
    },
    [busy],
  );

  const cancelEdit = useCallback(() => {
    // The anchor lock belongs to editing; keep the collapsed editor from holding a stale offset.
    centerLockUntil.current = 0;
    setEditing(null);
    setEditDraft('');
  }, []);

  const onEditInput = useCallback(() => {
    setEditDraft(serializeEditor(inlineEditorRef.current));
  }, []);

  const submitEdit = useCallback(() => {
    if (!editing) return;
    const el = inlineEditorRef.current;
    const text = (el ? serializeEditor(el) : editDraft).trim();
    if (!text || busy || sendingRef.current) return;
    if (!settings || !isConfigured(settings) || !page || !conversationId) return;
    const { localId, serverId } = editing;
    setEditing(null);
    setEditDraft('');
    void send(text, { editMessageId: serverId, editLocalId: localId });
  }, [busy, conversationId, editDraft, editing, page, send, settings]);

  const onEditPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    const el = inlineEditorRef.current;
    if (!text || !el) return;
    insertTextInto(el, text, null);
    onEditInput();
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
      if (!question) return;
      // Keep only the messages up to and including this user message
      const cutAt = r.user ? messages.findIndex((m) => m.id === r.user!.id) : messages.length;
      if (cutAt >= 0) setMessages((prev) => prev.slice(0, cutAt + 1));
      void send(question, { regenerate: true });
    },
    [busy, conversationId, messages, page, send, settings],
  );

  const newConversation = () => {
    if (busy) return;
    cancelScrollAnim();
    loadSeqRef.current += 1; // invalidate in-flight history loads so they can't refill the empty conversation
    suppressedResumeUrl.current = pageUrl;
    pendingConversation.current = false;
    // conversationId may already be null (e.g. after a failed first send); reset the spacer here
    // as well so an empty new chat cannot keep the old blank space.
    cancelLeadAnim();
    applyLead(0);
    applySpacer(0);
    contentHeight.current = 0;
    centerNext.current = false;
    setConversationId(null);
    setMessages([]);
    setHistoryOpen(false);
    setLoadError(null);
    setHistoryHasMore(false);
    setHistoryBefore(null);
    setLoadingEarlier(false);
    stickToBottom.current = true;
    setShowScrollBtn(false);
  };

  const openConversation = async (id: string) => {
    if (!settings || busy || id === conversationId) {
      setHistoryOpen(false);
      return;
    }
    suppressedResumeUrl.current = null;
    const mine = ++loadSeqRef.current;
    try {
      const conv = await getConversation(settings, id, { limit: HISTORY_PAGE_SIZE });
      if (mine !== loadSeqRef.current) return;
      if (pageUrl && conv.url !== normalizeUrl(pageUrl)) {
        setLoadError(t('error.historyLoad', { message: t('error.pageMismatch') }));
        return;
      }
      let stored = conv.messages;
      if (!editorHasDraft()) {
        const recovered = await recoverPendingQuestion(settings, conv.id).catch(() => null);
        if (mine !== loadSeqRef.current) return;
        if (recovered) {
          stored = stored.filter((m) => m.id !== recovered.messageId);
          fillEditor(recovered.text);
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
      stickToBottom.current = true;
      setShowScrollBtn(false);
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
      // The spacer delta logic must not treat prepended history as answer growth.
      cancelScrollAnim();
      prepended.current = true;
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return [...older.filter((m) => !seen.has(m.id)), ...prev];
      });
      setHistoryHasMore(conv.hasMore === true);
      setHistoryBefore(conv.nextBefore ?? null);
      // Prepending grows the scroll height; keep the user's viewport anchored instead of jumping.
      requestAnimationFrame(() => {
        if (!el) return;
        internalScrollUntil.current = performance.now() + 120;
        el.scrollTop = prevTop + (el.scrollHeight - prevHeight);
      });
    } catch (err) {
      prepended.current = false;
      if (mine === loadSeqRef.current) {
        setLoadError(t('error.historyLoad', { message: errText(err) }));
      }
    } finally {
      if (mine === loadSeqRef.current) setLoadingEarlier(false);
    }
  }, [settings, conversationId, historyHasMore, historyBefore, loadingEarlier, busy, page?.kind]);

  const removeConversation = async (id: string) => {
    if (!settings || busy) return;
    if (!window.confirm(t('history.deleteConfirm'))) return;
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

  /** Accept plain-text paste only, so external HTML never enters the editor */
  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n');
    insertTextAtCaret(text);
  };

  /** Dragging text in would otherwise let the browser insert HTML (and remote <img> tags). */
  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const text = e.dataTransfer.getData('text/plain').replace(/\r\n?/g, '\n');
    if (text) insertTextAtCaret(text);
    else if (e.dataTransfer.files.length > 0) showToast(t('composer.textOnly'));
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
  // Editor auto-grow. The corner radius is fixed (= half a single-line box), so only height changes shape;
  // animate height frame by frame in JS (CSS transitions are unreliable here: measuring natural height
  // needs height:auto first, and auto isn't interpolable, so browsers drop the transition and it jumps).
  useLayoutEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const from = el.offsetHeight;
    el.style.height = 'auto';
    const natural = el.scrollHeight;
    const to = Math.min(natural, MAX_BOX_H);
    el.style.height = `${from || to}px`;
    el.style.overflowY = natural > MAX_BOX_H ? 'auto' : 'hidden';

    if (!from || Math.abs(to - from) < 1) {
      el.style.height = `${to}px`;
      return;
    }

    const started = performance.now();
    const duration = 170;
    let raf = 0;
    const step = (now: number) => {
      const p = Math.min(1, (now - started) / duration);
      const eased = 1 - (1 - p) ** 3;
      el.style.height = `${from + (to - from) * eased}px`;
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [input, pageState.kind]);

  // Conversation title at top left, from the conversation list (the `title` event updates it in place)
  const currentTitle = useMemo(
    () => conversations.find((c) => c.id === conversationId)?.title ?? '',
    [conversations, conversationId],
  );

  // Group by turn: each turn's reasoning + tool calls collapse into one block
  const rounds = useMemo(() => buildRounds(messages), [messages]);

  return (
    <div className="app">
      <header className="hd">
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
            onClick={() => setSettingsOpen((v) => !v)}
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
        onScroll={onScroll}
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
                    disabled={!configured || busy}
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
          // The last phase that has text owns the copy/regenerate row; while B is still thinking,
          // answer A keeps its actions instead of losing them to an empty phase.
          const lastAnswerPhase = r.phases.reduce((acc, p, i) => (p.answers.length ? i : acc), -1);
          // Only the last turn can regenerate: the backend truncates after the last user message and reruns
          const isLastRound = roundIndex === rounds.length - 1;
          // More than 3h since the previous turn ended → insert a time row above this question;
          // otherwise time only fades in at the bubble's left edge on hover (never shown twice).
          const userAt = r.user?.createdAt ?? null;
          const prevEnd = roundIndex > 0 ? roundEndAt(rounds[roundIndex - 1]!) : null;
          const showSep = userAt != null && (prevEnd == null || userAt - prevEnd > TIME_SEP_GAP_MS);
          const userMsg = r.user;
          return (
          <div key={r.key} className="turn">
            {userMsg && (
              <>
                {showSep && <div className="time-sep">{fmtTime(userAt)}</div>}
                {editing?.localId === userMsg.id ? (
                  <div className="msg user editing">
                    <div className="inline-edit">
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
                        onDrop={(e) => e.preventDefault()}
                      />
                      <div className="inline-edit-actions">
                        <button type="button" className="edit-cancel" onClick={cancelEdit}>
                          {t('question.edit.cancel')}
                        </button>
                        <button
                          type="button"
                          className="edit-send"
                          disabled={!editDraft.trim() || busy}
                          onClick={submitEdit}
                        >
                          {t('question.edit.send')}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="msg user">
                    {/* Time outside the bubble follows its left edge (no drift when bubble widths differ) */}
                    <div className="bubble-wrap">
                      {!showSep && userAt != null && <span className="msg-time">{fmtClock(userAt)}</span>}
                      <div className="bubble">{renderUserText(userMsg.content)}</div>
                    </div>
                    {/* Same icon row as an answer's actions, mirrored to the bubble's right edge */}
                    <div className="msg-actions">
                      <button
                        type="button"
                        className="icon-btn"
                        title={copiedUserId === userMsg.id ? t('question.copied') : t('question.copy')}
                        aria-label={copiedUserId === userMsg.id ? t('question.copied') : t('question.copy')}
                        onClick={() => copyQuestion(userMsg)}
                      >
                        {copiedUserId === userMsg.id ? <IconCheck /> : <IconCopy />}
                      </button>
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
            {r.phases.map((p, pi) => {
              // A tool can finish before the next upstream segment starts. Keep the block in its
              // "thinking" state during that gap instead of collapsing to a 0.0s summary.
              const waiting = !p.answered && (p.running || (isLastRound && busy));
              const active = waiting;
              const isLastAnswerPhase = pi === lastAnswerPhase;
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

                  {p.answers.map((m, ai) => {
                    // Actions hang on the last answer of the turn, not on the last phase mid-stream.
                    // While the turn is busy, a later phase may still be waiting for its answer; keep
                    // the actions hidden then, otherwise they flash on answer A during a tool round.
                    const isLastAnswer = isLastAnswerPhase && ai === p.answers.length - 1;
                    const actionsReady = isLastAnswer && m.content && !m.streaming && !(isLastRound && busy);
                    return (
                      <div key={m.id} className="msg assistant">
                        <div className="answer" aria-live="polite" aria-busy={m.streaming || undefined}>
                          {m.content ? (
                            <div className={`md-wrap${m.streaming ? ' streaming' : ''}`}>
                              <MarkdownView text={m.content} streaming={m.streaming} baseUrl={page?.url} />
                            </div>
                          ) : null}
                          {m.error && <p className="err">{m.error}</p>}
                          {m.aborted && !m.streaming && <p className="muted small">{t('answer.truncated')}</p>}
                          {actionsReady && (
                            <div className="answer-actions">
                              <button
                                type="button"
                                className="icon-btn"
                                title={copiedId === m.id ? t('answer.copied') : t('answer.copy')}
                                aria-label={copiedId === m.id ? t('answer.copied') : t('answer.copy')}
                                onClick={() => copyRound(r, m.id)}
                              >
                                {copiedId === m.id ? <IconCheck /> : <IconCopy />}
                              </button>
                              {/* Only the last turn can regenerate: backend truncates after the last user message */}
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
                              {/* Verbose mode: stats follow the buttons on the right, same row */}
                              {verbose && (m.ms != null || m.tokensOut != null) && (
                                <span className="meta foot">
                                  {m.ms != null && <span>{(m.ms / 1000).toFixed(1)}s</span>}
                                  {m.tokensOut != null && (
                                    <span>{t('answer.usage', { out: m.tokensOut, in: m.tokensIn ?? '?' })}</span>
                                  )}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </Fragment>
              );
            })}
          </div>
          );
        })}
        {/* Scroll anchor: catches "taller than estimated" cases when pinned (table/KaTeX reflow) */}
        <div className="list-end" />
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
        configured={configured}
        pageReady={pageState.kind === 'ready'}
        busy={busy}
        canSend={canSend}
        selectionHint={selectionHint}
        onInput={onInput}
        onCompositionEnd={onCompositionEnd}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onDrop={onDrop}
        onSend={() => void send()}
        onStop={stop}
      />

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}



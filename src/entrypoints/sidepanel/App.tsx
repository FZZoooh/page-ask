import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MarkdownView } from '@/components/MarkdownView';
import { IconCheck, IconCopy, IconQuote, IconReload } from '@/components/icons';
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
  editorHasDraft as hasDraftIn,
  fillEditor as fillDomEditor,
  insertTextAtCaret as insertTextInto,
  serializeEditor,
} from './editorDom';

/** Editor max height (beyond this it scrolls internally); must match .editor max-height in style.css */
const MAX_BOX_H = 156;

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
        {part.slice(3, -4)}
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
  /** PDF reads need the backend URL, but load() must stay stable, so keep it in a ref, not a dep */
  const backendRef = useRef<string>(DEFAULT_SETTINGS.backendUrl);
  const listRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  /** Last caret inside the editor: selecting elsewhere replaces the document selection; restore this */
  const savedRange = useRef<Range | null>(null);
  const stickToBottom = useRef(true);
  /** Async callbacks must ask "did the user already send?", and only a ref holds the latest value */
  const messagesRef = useRef<Message[]>([]);
  /** Conversation load sequence: on tab switches or rapid history clicks only the latest request wins */
  const loadSeqRef = useRef(0);

  const fillEditor = useCallback((text: string) => {
    const el = editorRef.current;
    if (el) fillDomEditor(el, text);
    setInput(text);
  }, []);

  const editorHasDraft = useCallback(() => hasDraftIn(editorRef.current), []);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    if (settings?.backendUrl) backendRef.current = settings.backendUrl;
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
        if (commit) setConversations(list);
        return list;
      } catch {
        if (commit) setConversations([]);
        return [];
      }
    },
    [],
  );

  /* ---------------- Page loading ---------------- */

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setPageState({ kind: 'loading' });
    const result = await readActiveTab({ backendUrl: backendRef.current });
    if (mine !== seq.current) return; // a newer read started; drop this result
    if (result.ok) {
      // Key conversations by URL without #hash: anchors of one article must not become two conversations
      setPageState({ kind: 'ready', page: { ...result.page, url: normalizeUrl(result.page.url) } });
    } else {
      setPageState({ kind: 'failed', failure: result });
    }
    setShowPageText(false);
  }, []);

  useEffect(() => {
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
  }, [load]);

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

    if (!pageUrl || !settings) return;

    // After a tab/backend change the previous page's answer no longer belongs here. The server persists
    // whatever was generated, flagged aborted, but the new page must never receive the old run's events.
    const mine = ++loadSeqRef.current;
    let cancelled = false;
    setConversationId(null);
    setMessages([]);
    setHistoryOpen(false);
    setLoadError(null);

    void (async () => {
      const list = await refreshConversations(pageUrl, settings, false);
      const latest = list[0];
      if (cancelled || mine !== loadSeqRef.current) return;
      setConversations(list);
      if (!latest) return;
      // Auto-resume this page's most recent conversation
      try {
        const conv = await getConversation(settings, latest.id);
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

  useEffect(() => {
    const el = listRef.current;
    if (!el || !stickToBottom.current) return;
    // Setting scrollTop alone falls short when content grows afterwards (tables/KaTeX/code reflow), so
    // pin to the bottom anchor and correct again on the next frame to actually reach the bottom.
    el.scrollTop = el.scrollHeight;
    const raf = requestAnimationFrame(() => {
      if (stickToBottom.current) bottomRef.current?.scrollIntoView({ block: 'end' });
    });
    return () => cancelAnimationFrame(raf);
  }, [messages]);

  // Content grew on its own (images, table/math reflow) while the user is at the bottom: keep following it
  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let pending = 0;
    const ro = new ResizeObserver(() => {
      if (!stickToBottom.current) return;
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => {
        if (stickToBottom.current) el.scrollTop = el.scrollHeight;
      });
    });
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => {
      cancelAnimationFrame(pending);
      ro.disconnect();
    };
  }, [messages]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    // Scrolling moves the selection rect, so just dismiss the quote button
    setQuoteMenu(null);
  };

  /* ---------------- Answer selection → quote ---------------- */

  useEffect(() => {
    const hide = () => setQuoteMenu(null);

    const onUp = (e: MouseEvent) => {
      // Don't clear when the click lands on the quote button itself, or the menu dies before click fires
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('.quote-btn')) return;

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

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };

    document.addEventListener('mouseup', onUp);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', hide);
    return () => {
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', hide);
    };
  }, []);

  const serialize = useCallback(() => serializeEditor(editorRef.current), []);

  /** Used for plain-text paste; line breaks are left to Shift+Enter's native command */
  const insertTextAtCaret = useCallback((text: string) => {
    const el = editorRef.current;
    if (!el) return;
    insertTextInto(el, text, savedRange.current);
    setInput(serializeEditor(el));
  }, []);

  /** Insert a quote chip at the caret: contenteditable=false, so editing treats it as one character */
  const insertQuoteChip = (text: string) => {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    let range: Range | null = null;
    if (sel && sel.rangeCount > 0) {
      const cur = sel.getRangeAt(0);
      if (el.contains(cur.commonAncestorContainer)) range = cur;
    }
    // When the selection is elsewhere (answer text), go back to the last caret inside the editor
    const saved = savedRange.current;
    if (!range && saved && el.contains(saved.startContainer)) range = saved.cloneRange();
    if (!range) {
      range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
    }
    range.deleteContents();

    const chip = document.createElement('span');
    chip.className = 'q-chip';
    chip.contentEditable = 'false';
    chip.dataset.quote = text;
    chip.title = text;
    chip.textContent = text;

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
    async (raw?: string, opts?: { regenerate?: boolean }) => {
      const regenerate = Boolean(opts?.regenerate);
      const question = (raw ?? serialize()).trim();
      if (!question || !settings || busy || sendingRef.current) return;
      if (!isConfigured(settings) || !page) return;

      const runId = ++runSeqRef.current;
      abortRef.current?.abort();
      sendingRef.current = true;
      setInput('');
      if (!regenerate && editorRef.current) editorRef.current.innerHTML = '';
      savedRange.current = null;
      stickToBottom.current = true;

      // One question can produce several assistant segments (tool calls split them), so targetId
      // points at the bubble currently receiving text; it resets when a tool starts and recreates later.
      let targetId: string | null = crypto.randomUUID();
      const firstAsstId = targetId;
      setMessages((prev) => [
        ...prev,
        ...(regenerate ? [] : [{ id: crypto.randomUUID(), role: 'user' as const, content: question, createdAt: Date.now() }]),
        { id: firstAsstId, role: 'assistant', content: '', reasoning: '', streaming: true },
      ]);

      const controller = new AbortController();
      abortRef.current = controller;
      setBusy(true);

      // setState per token makes Markdown/KaTeX reflow over and over, so buffer for 50ms and
      // flush into state in one go.
      let contentBuf = '';
      let reasoningBuf = '';
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
        setMessages((prev) =>
          prev.map((m) => (m.id === id ? { ...m, content: m.content + c, reasoning: (m.reasoning ?? '') + r } : m)),
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
        // Screenshot and selection are independent: fetch in parallel to save a serial round-trip
        const [shot, sel] = await Promise.all([captureScreenshot(page.url), readSelection()]);
        const selected = sel?.text || page.selection || '';

        for await (const ev of streamChat({
          settings,
          conversationId,
          page: {
            url: page.url,
            title: page.title,
            markdown: page.markdown,
            viewport: page.viewport,
            kind: page.kind ?? 'web',
            pages: page.pages,
            selection: selected,
            selectionContext: sel,
          },
          screenshot: shot,
          text: question,
          regenerate,
          signal: controller.signal,
        })) {
          // A tab switch aborts and bumps runSeq; this extra guard keeps old-run events out of the new page
          if (runSeqRef.current !== runId) break;
          if (ev.type === 'meta') {
            convId = ev.conversationId;
            setConversationId(ev.conversationId);
          } else if (ev.type === 'content') {
            ensureTarget();
            contentBuf += ev.delta;
            schedule();
          } else if (ev.type === 'replace') {
            // Final output differs from streamed deltas: replace with final text so DB and UI don't diverge
            ensureTarget();
            contentBuf = ev.text;
            schedule();
          } else if (ev.type === 'reasoning') {
            ensureTarget();
            reasoningBuf += ev.delta;
            schedule();
          } else if (ev.type === 'usage') {
            setMessages((prev) => prev.map((m) => (m.id === targetId ? { ...m, usage: ev.usage } : m)));
          } else if (ev.type === 'tool') {
            if (ev.phase === 'start') {
              flush();
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
                  tokensIn: ev.totals?.tokensIn ?? m.tokensIn,
                  tokensOut: ev.totals?.tokensOut ?? m.tokensOut,
                  usage: ev.usage ?? m.usage,
                };
              }),
            );
          } else if (ev.type === 'title') {
            setConversations((prev) =>
              prev.map((c) => (c.id === ev.conversationId ? { ...c, title: ev.title } : c)),
            );
            setTitlePulse(true);
          } else if (ev.type === 'error') {
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
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current != null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  }, []);

  const stop = () => abortRef.current?.abort();

  /**
   * Copy the answer's raw Markdown; on success the icon briefly turns into a check.
   * One turn can have several answer segments (reasoning/tool calls split them) and the button
   * hangs on the last one only, so copy concatenates every segment in order.
   */
  const copyRound = useCallback((r: Round, anchorId: string) => {
    const text = r.answers
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

  /** Regenerate a turn: drop its answers locally, then rerun the same question with regenerate */
  const regenerateRound = useCallback(
    (r: Round) => {
      // Check every send precondition first, or the UI truncates while no request goes out
      if (busy || sendingRef.current || !settings || !isConfigured(settings) || !page) return;
      const question = r.user?.content ?? '';
      if (!question) return;
      // Keep only the messages up to and including this user message
      const cutAt = r.user ? messages.findIndex((m) => m.id === r.user!.id) : messages.length;
      if (cutAt >= 0) setMessages((prev) => prev.slice(0, cutAt + 1));
      void send(question, { regenerate: true });
    },
    [busy, messages, page, send, settings],
  );

  const newConversation = () => {
    if (busy) return;
    loadSeqRef.current += 1; // invalidate in-flight history loads so they can't refill the empty conversation
    setConversationId(null);
    setMessages([]);
    setHistoryOpen(false);
    setLoadError(null);
    stickToBottom.current = true;
  };

  const openConversation = async (id: string) => {
    if (!settings || busy || id === conversationId) {
      setHistoryOpen(false);
      return;
    }
    const mine = ++loadSeqRef.current;
    try {
      const conv = await getConversation(settings, id);
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
      setHistoryOpen(false);
      stickToBottom.current = true;
    } catch (err) {
      if (mine !== loadSeqRef.current) return;
      // On failure keep the conversation and only show a banner; never replace the list with an error bubble
      setLoadError(t('error.historyLoad', { message: errText(err) }));
    }
  };

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
      e.preventDefault();
      if (e.shiftKey) {
        // Use the native command to insert a line break: it maintains the trailing placeholder <br>,
        // so the first press already shows a blank line and arrow keys don't stick on zero-width chars.
        document.execCommand('insertLineBreak');
        setInput(serialize());
        return;
      }
      if (canSend) void send();
    }
  };

  /** Accept plain-text paste only, so external HTML never enters the editor */
  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n');
    insertTextAtCaret(text);
  };

  /* ---------------- Miscellaneous ---------------- */

  const handleCopy = async () => {
    if (!page) return;
    await navigator.clipboard.writeText(page.markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
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
            onClick={() => setHistoryOpen((v) => !v)}
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
      <div className="list" ref={listRef} onScroll={onScroll}>
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

        {rounds.map((r, roundIndex) => {
          // As soon as answer text starts, return to the static summary (and collapse) without waiting for the turn
          const active = r.running && !r.answered;
          // Only the last turn can regenerate: the backend truncates after the last user message and reruns
          const isLastRound = roundIndex === rounds.length - 1;
          // More than 3h since the previous turn ended → insert a time row above this question;
          // otherwise time only fades in at the bubble's left edge on hover (never shown twice).
          const userAt = r.user?.createdAt ?? null;
          const prevEnd = roundIndex > 0 ? roundEndAt(rounds[roundIndex - 1]!) : null;
          const showSep = userAt != null && (prevEnd == null || userAt - prevEnd > TIME_SEP_GAP_MS);
          return (
          <div key={r.key} className="turn">
            {r.user && (
              <>
                {showSep && <div className="time-sep">{fmtTime(userAt)}</div>}
                <div className="msg user">
                  {/* Time outside the bubble follows its left edge (no drift when bubble widths differ) */}
                  <div className="bubble-wrap">
                    {!showSep && userAt != null && <span className="msg-time">{fmtClock(userAt)}</span>}
                    <div className="bubble">{renderUserText(r.user.content)}</div>
                  </div>
                </div>
              </>
            )}

            {/* A turn's reasoning + tool calls collapse into one block: open while streaming, collapses on answer */}
            {verbose && (r.reasoning || r.steps.length > 0) && (
              <RoundPanel
                key={r.key}
                active={active}
                summary={
                  active
                    ? t('round.running')
                    : r.steps.length > 0 && r.reasoning
                      ? t('round.both', { tools: r.steps.length, secs: seconds(r.processMs) })
                      : r.steps.length > 0
                        ? t('round.toolsOnly', { tools: r.steps.length })
                        : t('round.thinkOnly', { secs: seconds(r.processMs) })
                }
              >
                {r.reasoning && <pre className="think-text">{r.reasoning}</pre>}
                {r.steps.map((m) => (
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
                      <span className="muted small">{t('tool.chars', { count: m.toolChars.toLocaleString() })}</span>
                    ) : null}
                  </div>
                ))}
              </RoundPanel>
            )}

            {/* Clean-mode placeholder: one per turn, so multiple tool calls never duplicate it */}
            {!verbose && r.running && <ThinkingFade show={active} />}

            {r.answers.map((m, ai) => {
              // Reasoning/tool calls can split a turn into several answers; actions hang on the last segment only
              const isLastAnswer = ai === r.answers.length - 1;
              return (
              <div key={m.id} className="msg assistant">
                <div className="answer" aria-live={m.streaming ? undefined : 'polite'}>
                  {m.content ? (
                    <div className={`md-wrap${m.streaming ? ' streaming' : ''}`}>
                      <MarkdownView text={m.content} />
                    </div>
                  ) : null}
                  {m.error && <p className="err">{m.error}</p>}
                  {m.aborted && !m.streaming && <p className="muted small">{t('answer.truncated')}</p>}
                  {isLastAnswer && m.content && !m.streaming && (
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
                      {isLastRound && (
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
          </div>
          );
        })}
        {/* Scroll anchor: catches "taller than estimated" cases when pinned (table/KaTeX reflow) */}
        <div ref={bottomRef} className="list-end" />
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
        onInput={() => setInput(serialize())}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
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



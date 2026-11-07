import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MarkdownView } from '@/components/MarkdownView';
import { IconCheck, IconChevron, IconCopy, IconQuote, IconReload, IconSend, IconStop } from '@/components/icons';
import {
  getConversation,
  deleteConversation,
  listConversations,
  recoverPendingQuestion,
  streamChat,
  type ConversationMeta,
  type StoredMessage,
  type Usage,
} from '@/lib/chat';
import {
  estimateTokens,
  captureScreenshot,
  readActiveTab,
  readSelection,
  type ExtractedPage,
  type ReadFailure,
} from '@/lib/extract';
import { t, type MessageKey } from '@/lib/i18n';
import {
  DEFAULT_SETTINGS,
  isConfigured,
  loadSettings,
  normalizeUrl,
  type Settings,
} from '@/lib/settings';
import { SettingsPanel } from './SettingsPanel';

/** 输入框最大高度（超过就内部滚动），必须与 style.css 的 .editor max-height 一致 */
const MAX_BOX_H = 156;

type PageState =
  | { kind: 'loading' }
  | { kind: 'ready'; page: ExtractedPage }
  | { kind: 'failed'; failure: ReadFailure };

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  reasoning?: string;
  /** 正在流式接收 */
  streaming?: boolean;
  /** 服务端标记：本轮被中止或上游截断（回答可能不完整） */
  aborted?: boolean;
  error?: string;
  ms?: number;
  /** 本轮「思考 + 工具调用」阶段耗时（毫秒），只有最终那段回答带 */
  processMs?: number;
  /** 入库时间，用来给没有 processMs 的老数据估算阶段耗时 */
  createdAt?: number;
  tokensIn?: number | null;
  tokensOut?: number | null;
  usage?: Usage;
  /** role === 'tool'：一次工具调用的过程 */
  toolName?: string;
  toolLabel?: string;
  toolDetail?: string;
  toolArgs?: Record<string, unknown>;
  toolState?: 'running' | 'done';
  toolOk?: boolean;
  toolChars?: number;
}

/** 毫秒 → 「3.4」（秒，保留一位小数）；没有数据时给「0.0」 */
function seconds(ms: number | null | undefined): string {
  return ((ms ?? 0) / 1000).toFixed(1);
}

/** 渲染用：一轮问答 = 用户消息 + 该轮的思考与工具调用 + 最终回答 */
interface Round {
  key: string;
  user: Message | null;
  reasoning: string;
  steps: Message[];
  answers: Message[];
  /** 这一轮还在进行（流式或工具在跑） */
  running: boolean;
  /** 正文已经开始输出：此时折叠块不再显示「正在思考」，也不必再展开 */
  answered: boolean;
  /** 「思考 + 工具调用」阶段耗时（毫秒）：回答开口前用了多久 */
  processMs: number | null;
  /** 阶段结束时刻（最后一条非回答消息的 createdAt），老数据靠它估算 */
  phaseEndAt: number | null;
}

/** 把扁平的消息流按「用户消息」切成轮次；思考与工具调用归到轮内 */
function buildRounds(list: Message[]): Round[] {
  const rounds: Round[] = [];
  const last = () => rounds[rounds.length - 1];

  for (const m of list) {
    if (m.role === 'user') {
      rounds.push({
        key: m.id,
        user: m,
        reasoning: '',
        steps: [],
        answers: [],
        running: false,
        answered: false,
        processMs: null,
        phaseEndAt: m.createdAt ?? null,
      });
      continue;
    }

    // 没有用户消息打头（例如从半轮恢复）时，补一个只有回答的轮
    if (!rounds.length) {
      rounds.push({
        key: `lead:${m.id}`,
        user: null,
        reasoning: '',
        steps: [],
        answers: [],
        running: false,
        answered: false,
        processMs: null,
        phaseEndAt: null,
      });
    }
    const r = last()!;

    if (m.role === 'tool') {
      r.steps.push(m);
      if (m.createdAt != null) r.phaseEndAt = m.createdAt;
      if (m.toolState === 'running') r.running = true;
      continue;
    }

    // assistant：只有 tool_calls、没有正文的段跳过（没内容可显示）
    if (!m.content && !m.reasoning && !m.error && !m.streaming) {
      if (m.createdAt != null) r.phaseEndAt = m.createdAt;
      continue;
    }
    if (m.reasoning) r.reasoning += m.reasoning;
    if (m.streaming) r.running = true;
    // 一旦正文或错误出现，本轮就算「已经开口」，折叠块立刻恢复静态摘要
    if (m.content || m.error) {
      r.answered = true;
      // 阶段耗时优先用后端给的精确值；老数据用「整轮耗时 − 回答自己那段耗时」倒推
      if (r.processMs == null) {
        const ownSpan = m.createdAt != null && r.phaseEndAt != null ? Math.max(0, m.createdAt - r.phaseEndAt) : null;
        r.processMs =
          m.processMs ??
          (m.ms != null && ownSpan != null
            ? Math.max(0, m.ms - ownSpan)
            : r.phaseEndAt != null && r.user?.createdAt != null
              ? Math.max(0, r.phaseEndAt - r.user.createdAt)
              : null);
      }
    } else if (m.createdAt != null) {
      // 只有 reasoning、还没开口的那一段：它的入库时刻就是阶段结束点
      r.phaseEndAt = m.createdAt;
    }
    if (m.content || m.error || m.streaming) r.answers.push(m);
  }

  return rounds;
}

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

/** 后端能给出错误码时优先用本地文案，否则退回原始 message */
const SERVER_ERROR_KEYS: Record<string, MessageKey> = {
  conversation_busy: 'error.conversationBusy',
};

function serverErrorText(code: string | undefined, message: string): string {
  const key = code ? SERVER_ERROR_KEYS[code] : undefined;
  return key ? t(key) : message;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 只有时刻（`16:04`）。悬停提示只想知道「几点」，不需要日期。 */
function fmtClock(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 列表与对话里的时间：今天只给时刻，其余都给「日 + 时刻」——
 * `16:04` / `昨天 16:04` / `周三 16:04` / `11/4 16:04` / `2025/11/2 16:04`。
 * 判断一律按**本地日历日**算差值（不是 24h 间隔），
 * 这样「1 月 2 日看 12 月 30 日」仍然算 3 天前 → 显示「周二 16:04」而不是「12/30」。
 */
function fmtTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const hm = fmtClock(ts);
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  // 夏令时下一天可能是 23/25 小时，用 round 收成整数天
  const dayDiff = Math.round((midnight(now) - midnight(d)) / 86_400_000);

  if (dayDiff <= 0) return hm; // 今天（时钟偏差导致的“未来”也按今天）
  if (dayDiff === 1) return `${t('history.yesterday')} ${hm}`;
  if (dayDiff < 7) return `${t(`weekday.${d.getDay()}` as MessageKey)} ${hm}`;

  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}/${md}`} ${hm}`;
}

/** 对话视图里：相邻两次提问间隔超过这个值就在中间插一行时间 */
const TIME_SEP_GAP_MS = 3 * 60 * 60 * 1000;

/** 一轮结束的时刻：最后一条回答的入库时间 → 阶段结束时刻 → 用户消息时刻 */
function roundEndAt(r: Round): number | null {
  const last = r.answers[r.answers.length - 1];
  return last?.createdAt ?? r.phaseEndAt ?? r.user?.createdAt ?? null;
}

const TOOL_LABEL_KEYS: Record<string, MessageKey> = {  read_page: 'tool.read_page',
  web_search: 'tool.web_search',
  fetch_url: 'tool.fetch_url',
  screenshot: 'tool.screenshot',
};

/** PDF 页面上，read_page 实际读的是 PDF 文本层，标签也得跟着变 */function toolLabel(name: string, pdf = false): string {
  if (name === 'read_page' && pdf) return t('tool.read_pdf');
  const key = TOOL_LABEL_KEYS[name];
  return key ? t(key) : (name || t('tool.unknown'));
}

/** 工具参数的一句话摘要，给步骤条用 */
function toolDetail(name: string, args: Record<string, unknown> | null): string {
  if (!args) return '';
  if (name === 'read_page') {
    if (args.scope === 'viewport') return t('tool.detail.viewport');
    const q = typeof args.query === 'string' ? args.query : '';
    if (q) return t('tool.detail.search', { query: q });
    const offset = Number(args.offset) || 0;
    return offset > 0 ? t('tool.detail.offset', { start: offset + 1 }) : t('tool.detail.full');
  }
  if (name === 'web_search') return String(args.query ?? '');
  if (name === 'fetch_url') return String(args.url ?? '');
  return '';
}

function toMessage(m: StoredMessage, pdf = false): Message | null {
  if (m.role === 'tool') {
    return {
      id: m.id,
      role: 'tool',
      content: m.content,
      toolName: m.toolName ?? 'tool',
      toolLabel: toolLabel(m.toolName ?? '', pdf),
      toolDetail: toolDetail(m.toolName ?? '', m.toolArgs ?? null),
      toolArgs: m.toolArgs ?? undefined,
      toolState: 'done',
      toolOk: m.toolFailed !== true,
      toolChars: m.content.length,
    };
  }
  // 只带 tool_calls、没有正文的 assistant 段在 UI 里没有内容可显示
  if (m.role === 'assistant' && !m.content.trim() && !m.reasoning.trim()) return null;
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    reasoning: m.reasoning,
    ms: m.ms ?? undefined,
    processMs: m.processMs ?? undefined,
    aborted: m.aborted === true,
    createdAt: m.createdAt,
    tokensIn: m.tokensIn,
    tokensOut: m.tokensOut,
  };
}

function toMessages(list: StoredMessage[], pdf = false): Message[] {
  return list.map((m) => toMessage(m, pdf)).filter((m): m is Message => m !== null);
}

/** 用户气泡里的 <q>…</q> 片段渲染成行内引用（其余按原样文字） */
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
/** 正文出现前那句「正在思考」：出现时淡入，正文一到淡出并塌陷 */
function ThinkingFade({ show }: { show: boolean }) {
  const [mounted, setMounted] = useState(show);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (show) {
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const timer = setTimeout(() => setMounted(false), 240);
    return () => clearTimeout(timer);
  }, [show, mounted]);

  if (!mounted) return null;
  return <div className={`thinking${closing ? ' out' : ''}`}>{t('answer.thinking')}</div>;
}

/** 思考/工具折叠块：流式时展开，结束后自动收起；流式期间用户手动收起不会被下一批 token 顶开 */
function RoundPanel({ active, summary, children }: { active: boolean; summary: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const wasActive = useRef(active);

  useEffect(() => {
    if (wasActive.current === active) return;
    wasActive.current = active;
    if (ref.current) ref.current.open = active;
  }, [active]);

  return (
    <details ref={ref} className="round" open={active}>
      <summary>{summary}</summary>
      {children}
    </details>
  );
}
export default function App() {
  const [pageState, setPageState] = useState<PageState>({ kind: 'loading' });
  const [showPageText, setShowPageText] = useState(false);
  const [copied, setCopied] = useState(false);

  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 标题刚由后端生成时置真，跑一次从左往右淡入；加载历史对话不会触发 */
  const [titlePulse, setTitlePulse] = useState(false);

  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** 读历史/切会话失败时挂在列表顶部的提示；不替换当前消息 */
  const [loadError, setLoadError] = useState<string | null>(null);

  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  /** 选中回答文字时浮出的「引用」小按钮（视口坐标 + 选中的原文） */
  const [quoteMenu, setQuoteMenu] = useState<{ left: number; top: number; text: string } | null>(null);

  const seq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  /** 同步的「正在发送」闸门：busy 是 state，连点两下会在重渲染前都通过 */
  const sendingRef = useRef(false);
  /** 每次 send 递增；晚到的 finally 不能清掉新一轮的 busy */
  const runSeqRef = useRef(0);
  /** 读 PDF 需要后端地址，但 load() 要稳定，所以走 ref 不进食依赖 */
  const backendRef = useRef<string>(DEFAULT_SETTINGS.backendUrl);
  const listRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  /** 编辑器内最后一次光标位置：去别处选文字会顶掉文档选区，插入引用时要能回到原位 */
  const savedRange = useRef<Range | null>(null);
  const stickToBottom = useRef(true);
  /** 异步回调里要判断“用户是否已经先发了消息”，读 ref 才能拿到最新值 */
  const messagesRef = useRef<Message[]>([]);
  /** 会话加载序号：切页、连点历史时只认最后一次请求的结果 */
  const loadSeqRef = useRef(0);

  /** 把恢复出来的提问填回输入框；消息里序列化的 <q>…</q> 还原成引用 chip */
  const fillEditor = useCallback((text: string) => {
    const el = editorRef.current;
    if (!el) {
      setInput(text);
      return;
    }
    el.innerHTML = '';
    for (const part of text.split(/(<q>[\s\S]*?<\/q>)/g)) {
      if (!part) continue;
      const m = /^<q>([\s\S]*)<\/q>$/.exec(part);
      if (!m) {
        el.appendChild(document.createTextNode(part));
        continue;
      }
      const quote = m[1] ?? '';
      const chip = document.createElement('span');
      chip.className = 'q-chip';
      chip.contentEditable = 'false';
      chip.dataset.quote = quote;
      chip.title = quote;
      chip.textContent = quote;
      el.appendChild(chip);
    }
    setInput(text);
  }, []);

  /** 输入框里已经有用户草稿时不要用恢复内容覆盖它 */
  const editorHasDraft = useCallback(() => Boolean(editorRef.current?.textContent?.trim()), []);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    if (settings?.backendUrl) backendRef.current = settings.backendUrl;
  }, [settings]);

  const page = pageState.kind === 'ready' ? pageState.page : null;
  const pageUrl = page?.url ?? null;
  const configured = isConfigured(settings);
  /** 显示详细信息：关掉后只留正文，页面卡片/思考折叠块/统计都隐藏 */
  const verbose = settings?.verbose !== false;

  /* ---------------- 会话列表 ---------------- */

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

  /* ---------------- 页面读取 ---------------- */

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setPageState({ kind: 'loading' });
    const result = await readActiveTab({ backendUrl: backendRef.current });
    if (mine !== seq.current) return; // 有更新的一次读取，丢弃这次结果
    if (result.ok) {
      // 用去掉 #hash 的 URL 当会话键：同一篇文章的锚点不该分成两个对话
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

  useEffect(() => {
    void loadSettings().then(setSettings);
  }, []);

  /* ---------------- 换页 → 换会话 ---------------- */

  useEffect(() => {
    // 页面切走时（哪怕新页面不可读）也要先中止旧 run，避免它继续把事件写进新页面
    if (abortRef.current || sendingRef.current) {
      runSeqRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      sendingRef.current = false;
      setBusy(false);
    }

    if (!pageUrl || !settings) return;

    // 换页/换后端后，上一页的回答已经不属于当前画面。服务端会把已生成的部分按 aborted 落库，
    // 但新页面绝不接收旧 run 的事件。
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
      // 自动续上这一页最近的一次对话
      try {
        const conv = await getConversation(settings, latest.id);
        if (cancelled || mine !== loadSeqRef.current) return;
        // 两次网络往返期间用户可能已经发了新问题，不能再整体覆盖消息列表
        if (sendingRef.current || messagesRef.current.length > 0) return;
        let stored = conv.messages;
        // 上次进程中途退出会留下“最后一条 user 没有回答”，把问题取回输入框并从历史里删掉
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
    // verbose 不进依赖：改显示偏好不该重载会话；只有换页或换后端才重新归属
  }, [pageUrl, settings?.backendUrl, refreshConversations, fillEditor, editorHasDraft, page?.kind]);

  /* ---------------- 滚动 ---------------- */

  useEffect(() => {
    const el = listRef.current;
    if (!el || !stickToBottom.current) return;
    // 直接写 scrollTop 在「内容随后又变高」时会差一截（表格/KaTeX/代码块重排），
    // 用底部锚点 + 下一帧再校一次，保证真的贴到底。
    el.scrollTop = el.scrollHeight;
    const raf = requestAnimationFrame(() => {
      if (stickToBottom.current) bottomRef.current?.scrollIntoView({ block: 'end' });
    });
    return () => cancelAnimationFrame(raf);
  }, [messages]);

  // 内容自己变高（图片加载、表格/公式重排）而用户还在底部时，跟着贴底
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
    // 滚动时选区位置已经变了，直接收起引用按钮
    setQuoteMenu(null);
  };

  /* ---------------- 选中回答 → 引用 ---------------- */

  useEffect(() => {
    const hide = () => setQuoteMenu(null);

    const onUp = (e: MouseEvent) => {
      // 点在「引用」按钮自己身上时不要清掉，否则 click 之前菜单就没了
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
      // 只对「助手回答」里的文字生效（用户自己的气泡、步骤条不弹）
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

  /** 把 contenteditable 的内容序列化成消息文本：引用 chip → <q>…</q>，其余按字面 */
  const serialize = useCallback((): string => {
    const el = editorRef.current;
    if (!el) return '';
    const out = { s: '' };
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        out.s += (node.nodeValue ?? '').replace(/\u200b/g, '');
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const e = node as HTMLElement;
      const q = e.dataset?.quote;
      if (q != null) {
        out.s += `<q>${q}</q>`;
        return;
      }
      if (e.tagName === 'BR') {
        out.s += '\n';
        return;
      }
      e.childNodes.forEach(walk);
    };
    el.childNodes.forEach(walk);
    return out.s.replace(/\n{3,}$/, '\n');
  }, []);

  /** 在光标处插入纯文本（\n → <br>）：不再依赖已废弃的 execCommand */
  const insertTextAtCaret = useCallback(
    (text: string) => {
      const el = editorRef.current;
      if (!el) return;
      el.focus();
      const sel = window.getSelection();
      let range: Range | null = null;
      if (sel && sel.rangeCount > 0) {
        const cur = sel.getRangeAt(0);
        if (el.contains(cur.commonAncestorContainer)) range = cur;
      }
      const saved = savedRange.current;
      if (!range && saved && el.contains(saved.startContainer)) range = saved.cloneRange();
      if (!range) {
        range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
      }
      range.deleteContents();
      const frag = document.createDocumentFragment();
      text.split('\n').forEach((line, i) => {
        if (i > 0) frag.appendChild(document.createElement('br'));
        if (line) frag.appendChild(document.createTextNode(line));
      });
      const tail = frag.lastChild;
      range.insertNode(frag);
      if (tail) {
        const after = document.createRange();
        after.setStartAfter(tail);
        after.collapse(true);
        savedRange.current = after.cloneRange();
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(after);
        }
      }
      setInput(serialize());
    },
    [serialize],
  );

  /** 在光标处插入一个引用 chip：contenteditable=false，编辑时相当于一个字符 */
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
    // 选区落在别处（选回答文字）时，回到上次在编辑器里的光标
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

    // 光标落到 chip 之后。Chromium 能直接停在行内元素后面，不需要零宽占位符
    // （零宽字符会多出一个方向键停靠点，导航时会「卡一下」）。
    const after = document.createRange();
    after.setStartAfter(chip);
    after.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(after);
    savedRange.current = after.cloneRange();

    setInput(serialize());
  };

  /** 把选中的回答文字插成光标处的引用 chip */
  const applyQuote = () => {
    if (!quoteMenu) return;
    const text = quoteMenu.text.trim();
    setQuoteMenu(null);
    window.getSelection()?.removeAllRanges();
    if (!text) return;
    requestAnimationFrame(() => insertQuoteChip(text));
  };

  /* ---------------- 发送 ---------------- */

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

      // 一次提问可能有多个 assistant 段（工具调用会被切成几段），
      // targetId 指向「当前正在接收文字的那个气泡」；工具开始后置空，下一段文字再新建。
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

      // 每来一个 token 就 setState 会让 Markdown/KaTeX 反复重排，
      // 这里攒 50ms 再一次性刷进状态。
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
      /** 工具跑完再出文字时，开一个新的 assistant 气泡 */
      const ensureTarget = () => {
        if (targetId) return;
        const id = crypto.randomUUID();
        targetId = id;
        setMessages((prev) => [...prev, { id, role: 'assistant', content: '', reasoning: '', streaming: true }]);
      };

      let convId = conversationId;
      /** 服务端用 done 结束一轮；没等到 done 就断流，不能当成功 */
      let sawDone = false;
      /** 服务端已经发过 error：收尾时别再把它覆盖成笼统的“连接中断” */
      let sawError = false;

      // 先截一张当前可见画面：模型调用 screenshot 工具时才有得用，不调用就不发上游
      // 截屏与选区读取都放在 try 里：任一失败也要走 finally 释放发送闸门
      try {
        // 截屏与选区互不依赖，并行取，少一次串行等待
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
          // 切页会 abort 并将 runSeq 递增；这里再兜一层，旧 run 的事件绝不写进新页面
          if (runSeqRef.current !== runId) break;
          if (ev.type === 'meta') {
            convId = ev.conversationId;
            setConversationId(ev.conversationId);
          } else if (ev.type === 'content') {
            ensureTarget();
            contentBuf += ev.delta;
            schedule();
          } else if (ev.type === 'replace') {
            // 最终 output 与流式 delta 不一致：以最终文本为准整段替换，避免落库与界面分叉
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
                        // 服务端的 label/detail 更准（比如「可见区域 638 字」）
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
            // 回答已经结束：立刻放开输入框，不必等服务端为自动标题多挂 20 秒连接
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
            const text = serverErrorText(ev.code, ev.message);
            setMessages((prev) =>
              prev.map((m) => (m.id === targetId ? { ...m, streaming: false, error: text } : m)),
            );
          }
        }
        if (runSeqRef.current === runId && !sawDone && !sawError) {
          if (controller.signal.aborted) {
            // 响应头还没到就被停止：streamChat 会静默返回，这里擦掉空气泡
            setMessages((prev) =>
              prev
                .filter((m) => m.id !== targetId || m.content || m.reasoning)
                .map((m) => (m.streaming ? { ...m, streaming: false } : m)),
            );
          } else {
            // 服务端没发 done 就关流：回答可能只写了一半，按错误收尾
            throw new Error(t('error.streamCut'));
          }
        }
      } catch (err) {
        if (runSeqRef.current !== runId) return;
        flush();
        // done 之后只剩自动标题/连接收尾；这时断流不影响已经完整收到的回答
        if (sawDone || sawError) return;
        const stopped = controller.signal.aborted;
        setMessages((prev) => {
          // 还没产出任何文字就被停掉时，别留一个空气泡
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
        // 新一轮已经开始时，晚到的收尾不能把它的 busy/闸门清掉
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
   * 复制回答的 Markdown 原文；成功后按钮图标短暂变成对勾。
   * 一轮里可能有多段正文（思考/工具调用把它切开），按钮只挂在最后一段上，
   * 复制时按顺序把整轮所有正文拼起来。
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

  /** 重新生成某一轮：本地删掉这一轮的回答，再带 regenerate 重跑同一个问题 */
  const regenerateRound = useCallback(
    (r: Round) => {
      // 先把 send 的所有前置条件查一遍，避免 UI 已截断、请求却没发出去
      if (busy || sendingRef.current || !settings || !isConfigured(settings) || !page) return;
      const question = r.user?.content ?? '';
      if (!question) return;
      // 只保留这条 user 之前的消息
      const cutAt = r.user ? messages.findIndex((m) => m.id === r.user!.id) : messages.length;
      if (cutAt >= 0) setMessages((prev) => prev.slice(0, cutAt + 1));
      void send(question, { regenerate: true });
    },
    [busy, messages, page, send, settings],
  );

  const newConversation = () => {
    if (busy) return;
    loadSeqRef.current += 1; // 作废还在路上的历史加载，避免它把空会话又填满
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
      // 失败时保留当前对话，只在顶部挂一条提示；不能把消息列表替换成错误气泡
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
      // 删除失败同样不动当前对话
      setLoadError(t('error.historyDelete', { message: errText(err) }));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // isComposing: 中文输入法选词时按 Enter 不能当发送
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (e.shiftKey) {
        // 用浏览器原生命令插换行：它会自己维护行尾占位 <br>，
        // 首次按就能看到空行，方向键也不会被零宽字符卡住。
        document.execCommand('insertLineBreak');
        setInput(serialize());
        return;
      }
      if (canSend) void send();
    }
  };

  /** 只收纯文本粘贴，避免把外部 HTML 带进编辑器 */
  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n');
    insertTextAtCaret(text);
  };

  /* ---------------- 杂项 ---------------- */

  const handleCopy = async () => {
    if (!page) return;
    await navigator.clipboard.writeText(page.markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // 记住编辑器里的光标位置：用户会先点进输入框，再去上面选一段回答文字，
  // 那次选择会顶掉文档选区，所以插入引用时要靠这个快照回到原位。
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
  // 输入框自增高。圆角半径固定（= 单行盒子半高），所以形状变化只来自高度；
  // 高度用 JS 逐帧补间（CSS transition 在这里不可靠：量自然高度要先把 height 设成 auto，
  // 而 auto 不是可插值值，浏览器会直接放弃过渡，看起来就是跳变）。
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

  // 顶部左侧显示的对话标题：来自会话列表（自动起标题后 `title` 事件会就地更新它）
  const currentTitle = useMemo(
    () => conversations.find((c) => c.id === conversationId)?.title ?? '',
    [conversations, conversationId],
  );

  // 按轮次分组：每轮的思考 + 工具调用收进一个折叠块
  const rounds = useMemo(() => buildRounds(messages), [messages]);

  return (
    <div className="app">
      <header className="hd">
        {/* 顶部左侧：当前对话标题（首轮回答后由自动起标题写入，没生成前留空） */}
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
            setSettings(next);
            setSettingsOpen(false);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {historyOpen && (
        <section className="card convs">
          <div className="card-head">
            <span className="muted small">{t('history.hint')}</span>
          </div>
          {conversations.length === 0 && <p className="muted small">{t('history.empty')}</p>}
          {conversations.map((c) => (
            <div key={c.id} className={`conv ${c.id === conversationId ? 'on' : ''}`}>
              <button className="conv-main" onClick={() => void openConversation(c.id)} disabled={busy}>
                <span className="conv-t">{c.title || c.lastUserText || t('history.untitled')}</span>
                <span className="conv-m">
                  {fmtTime(c.lastMessageAt ?? c.updatedAt)}  {t('history.count', { count: c.messageCount ?? 0 })}
                </span>
              </button>
              <button
                className="conv-del"
                title={t('history.delete')}
                aria-label={t('history.delete')}
                onClick={() => void removeConversation(c.id)}
                disabled={busy}
              >
                ×
              </button>
            </div>
          ))}
        </section>
      )}

      {/* 页面卡片：默认只留一行，避免挤占对话空间；清爽模式下整块不渲染 */}
      {pageState.kind === 'ready' && verbose && (
        <section className="page">
          {/* 整块（标题 + 元信息）都可点，折叠箭头只是指示器 */}
          <button
            type="button"
            className="page-toggle"
            onClick={() => setShowPageText((v) => !v)}
            title={showPageText ? t('page.text.hide') : t('page.text')}
            aria-label={showPageText ? t('page.text.hide') : t('page.text')}
            aria-expanded={showPageText}
          >
            <span className="page-head">
              <span className="page-title" title={pageState.page.title}>
                {pageState.page.title || t('page.title.untitled')}
              </span>
              <span className="chev">
                <IconChevron open={showPageText} />
              </span>
            </span>
            <span className="meta">
            <span>{pageState.page.site}</span>
            {pageState.page.kind === 'pdf' && pageState.page.pages ? (
              <>
                <span className="tag">{t('page.pdf', { pages: pageState.page.pages })}</span>
              </>
            ) : null}
            <span>{t('page.chars', { count: pageState.page.chars.toLocaleString() })}</span>
            <span>
              {t('page.tokens', { count: estimateTokens(pageState.page.chars).toLocaleString() })}
            </span>
            <span>{t('page.tookMS', { count: pageState.page.tookMs })}</span>
              {pageState.page.chars > 30000 && <span className="warn">{t('page.longWarning')}</span>}
            </span>
          </button>
          {showPageText && (
            <>
              <div className="card-head">
                <span className="muted small">{t('page.text.title')}</span>
                <button className="ghost" onClick={() => void handleCopy()}>
                  {copied ? t('page.copied') : t('page.copy')}
                </button>
              </div>
              <pre className="preview">{pageState.page.markdown || t('page.text.empty')}</pre>
            </>
          )}
        </section>
      )}

      {pageState.kind === 'failed' && (
        <section className="card error">
          <div className="card-title">{t('page.failure.title')}</div>
          <p>{t(REASON_HINT[pageState.failure.reason])}</p>
          <pre className="raw">{pageState.failure.message}</pre>
        </section>
      )}

      {/* 对话区 */}
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
          // 正文一开始输出就切回静态摘要（并收起），不必等整轮结束
          const active = r.running && !r.answered;
          // 只有最后一轮能「重新生成」：后端是把最后一条 user 之后的内容砍掉重跑
          const isLastRound = roundIndex === rounds.length - 1;
          // 与上一轮的结束时刻隔了 3 小时以上 → 在这条提问上方插一行时间；
          // 否则时间只在鼠标悬停时从气泡左侧淡入（不重复显示）
          const userAt = r.user?.createdAt ?? null;
          const prevEnd = roundIndex > 0 ? roundEndAt(rounds[roundIndex - 1]!) : null;
          const showSep = userAt != null && (prevEnd == null || userAt - prevEnd > TIME_SEP_GAP_MS);
          return (
          <div key={r.key} className="turn">
            {r.user && (
              <>
                {showSep && <div className="time-sep">{fmtTime(userAt)}</div>}
                <div className="msg user">
                  {/* 时间挂在气泡外层，跟着气泡左缘走（气泡宽度不同也不会飘到行首） */}
                  <div className="bubble-wrap">
                    {!showSep && userAt != null && <span className="msg-time">{fmtClock(userAt)}</span>}
                    <div className="bubble">{renderUserText(r.user.content)}</div>
                  </div>
                </div>
              </>
            )}

            {/* 一轮里的「思考 + 工具调用」收进一个折叠块：流式时展开，答完自动收起 */}
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

            {/* 清爽模式的占位：整轮只有一个，多轮工具调用也不会重复 */}
            {!verbose && r.running && <ThinkingFade show={active} />}

            {r.answers.map((m, ai) => {
              // 一轮里可能被思考/工具调用切成多段正文：操作按钮只挂在最后一段上
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
                      {/* 只有最后一轮能重生成：后端是把最后一条 user 之后的内容砍掉重跑 */}
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
                      {/* 详细模式：统计信息跟在按钮右边，同一行 */}
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
        {/* 滚动锚点：贴底时用它兜住「实际比预估更高」的情况（表格、KaTeX 重排） */}
        <div ref={bottomRef} className="list-end" />
      </div>

      {/* 选中回答文字时浮出的「引用」按钮 */}
      {quoteMenu && (
        <button
          className="quote-btn"
          style={{ left: quoteMenu.left, top: quoteMenu.top }}
          title={t('quote.action.title')}
          aria-label={t('quote.action')}
          // 用 mousedown 拦一下，保住选区，click 才拿得到
          onMouseDown={(e) => e.preventDefault()}
          onClick={applyQuote}
        >
          <IconQuote />
        </button>
      )}

      {/* 输入区：单行是胶囊，多行平滑长成圆角矩形 */}
      <div className="composer">
        <div className="box">
          <div
            ref={editorRef}
            className="editor"
            contentEditable={configured && pageState.kind === 'ready'}
            role="textbox"
            aria-multiline="true"
            aria-label={t('composer.placeholder.ready')}
            suppressContentEditableWarning
            data-placeholder={
              !configured
                ? t('composer.placeholder.noSettings')
                : pageState.kind !== 'ready'
                  ? t('composer.placeholder.noPage')
                  : t('composer.placeholder.ready')
            }
            onInput={() => setInput(serialize())}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          {busy ? (
            <button
              className="send stop"
              onClick={stop}
              title={t('composer.stop')}
              aria-label={t('composer.stop')}
            >
              <IconStop />
            </button>
          ) : (
            <button
              className="send"
              onClick={() => void send()}
              disabled={!canSend}
              title={t('composer.send')}
              aria-label={t('composer.send')}
            >
              <IconSend />
            </button>
          )}
        </div>
      </div>

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}



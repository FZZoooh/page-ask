import { t, type MessageKey } from '@/lib/i18n';
import type { StoredMessage, Usage } from '@/lib/chat';

export interface Message {
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

/** 渲染用：一轮问答 = 用户消息 + 该轮的思考与工具调用 + 最终回答 */
export interface Round {
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

/** 毫秒 → 「3.4」（秒，保留一位小数）；没有数据时给「0.0」 */
export function seconds(ms: number | null | undefined): string {
  return ((ms ?? 0) / 1000).toFixed(1);
}

/** 把扁平的消息流按「用户消息」切成轮次；思考与工具调用归到轮内 */
export function buildRounds(list: Message[]): Round[] {
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

/** 只有时刻（`16:04`）。悬停提示只想知道「几点」，不需要日期。 */
export function fmtClock(ts: number): string {
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
export function fmtTime(ts: number): string {
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
export const TIME_SEP_GAP_MS = 3 * 60 * 60 * 1000;

/** 一轮结束的时刻：最后一条回答的入库时间 → 阶段结束时刻 → 用户消息时刻 */
export function roundEndAt(r: Round): number | null {
  const last = r.answers[r.answers.length - 1];
  return last?.createdAt ?? r.phaseEndAt ?? r.user?.createdAt ?? null;
}

const TOOL_LABEL_KEYS: Record<string, MessageKey> = {
  read_page: 'tool.read_page',
  web_search: 'tool.web_search',
  fetch_url: 'tool.fetch_url',
  screenshot: 'tool.screenshot',
};

/** PDF 页面上，read_page 实际读的是 PDF 文本层，标签也得跟着变 */
export function toolLabel(name: string, pdf = false): string {
  if (name === 'read_page' && pdf) return t('tool.read_pdf');
  const key = TOOL_LABEL_KEYS[name];
  return key ? t(key) : name || t('tool.unknown');
}

/** 工具参数的一句话摘要，给步骤条用 */
export function toolDetail(name: string, args: Record<string, unknown> | null): string {
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

export function toMessage(m: StoredMessage, pdf = false): Message | null {
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

export function toMessages(list: StoredMessage[], pdf = false): Message[] {
  return list.map((m) => toMessage(m, pdf)).filter((m): m is Message => m !== null);
}

import { t, type MessageKey } from '@/lib/i18n';
import { clockTime, formatTime } from '@/lib/format-time.mjs';
import type { StoredMessage, Usage } from '@/lib/chat';

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  reasoning?: string;
  /** Currently streaming in */
  streaming?: boolean;
  /** Server flag: this turn was aborted or the upstream truncated (the answer may be incomplete) */
  aborted?: boolean;
  error?: string;
  ms?: number;
  /** Think + tool phase duration (ms) for this turn; only the final answer segment carries it */
  processMs?: number;
  /** Persist time, used to estimate the phase duration for old rows without processMs */
  createdAt?: number;
  tokensIn?: number | null;
  tokensOut?: number | null;
  usage?: Usage;
  /** role === 'tool': one tool invocation's progress */
  toolName?: string;
  toolLabel?: string;
  toolDetail?: string;
  toolArgs?: Record<string, unknown>;
  toolState?: 'running' | 'done';
  toolOk?: boolean;
  toolChars?: number;
}

/** Render model: one turn = user message + its reasoning and tool calls + final answer */
export interface Round {
  key: string;
  user: Message | null;
  reasoning: string;
  steps: Message[];
  answers: Message[];
  /** This turn is still running (streaming or a tool is in flight) */
  running: boolean;
  /** Answer text has started: the collapsed block stops saying "thinking" and need not expand again */
  answered: boolean;
  /** Think + tool phase duration (ms): how long it took before the answer began */
  processMs: number | null;
  /** Phase end time (createdAt of the last non-answer message); old rows rely on it for estimates */
  phaseEndAt: number | null;
}

/** Milliseconds → "3.4" (seconds, one decimal); falls back to "0.0" when there is no data */
export function seconds(ms: number | null | undefined): string {
  return ((ms ?? 0) / 1000).toFixed(1);
}

/** Split the flat message stream into turns at each user message; reasoning and tool calls stay in-turn */
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

    // No user message leads (e.g. recovering mid-turn): synthesize a turn that holds only the answer
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

    // assistant: skip segments with only tool_calls and no content — nothing to render
    if (!m.content && !m.reasoning && !m.error && !m.streaming) {
      if (m.createdAt != null) r.phaseEndAt = m.createdAt;
      continue;
    }
    if (m.reasoning) r.reasoning += m.reasoning;
    if (m.streaming) r.running = true;
    // Once content or an error appears the turn has "spoken"; the collapsed block returns to a static summary
    if (m.content || m.error) {
      r.answered = true;
      // Prefer the backend's exact phaseMs; old rows derive it as whole-turn ms minus the answer segment's span
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
      // A reasoning-only segment before the answer: its persist time is the phase end
      r.phaseEndAt = m.createdAt;
    }
    if (m.content || m.error || m.streaming) r.answers.push(m);
  }

  return rounds;
}

/** Clock time only (`16:04`). A hover tooltip only wants the hour, not the date. */
export function fmtClock(ts: number): string {
  return clockTime(ts);
}

/**
 * Times in the list and conversation: today shows the clock only, everything else "day + clock" —
 * `16:04` / `Yesterday 16:04` / `Wednesday 16:04` / `11/4 16:04` / `2025/11/2 16:04`.
 * Always diff by **local calendar day** (not a 24h span), so "on Jan 2 looking at Dec 30" is still
 * 3 days ago → "Tuesday 16:04" rather than "12/30".
 */
export function fmtTime(ts: number, nowMs = Date.now()): string {
  return formatTime(ts, nowMs, {
    yesterday: t('history.yesterday'),
    weekdays: [0, 1, 2, 3, 4, 5, 6].map((day) => t(`weekday.${day}` as MessageKey)),
  });
}

/** Conversation view: insert a time separator when consecutive questions are further apart than this */
export const TIME_SEP_GAP_MS = 3 * 60 * 60 * 1000;

/** End of a turn: last answer's persist time → phase end → user message time */
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

/** On a PDF page read_page actually reads the PDF text layer, so its label has to change too */
export function toolLabel(name: string, pdf = false): string {
  if (name === 'read_page' && pdf) return t('tool.read_pdf');
  const key = TOOL_LABEL_KEYS[name];
  return key ? t(key) : name || t('tool.unknown');
}

/** One-line summary of tool args for the step rows */
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
  // An assistant segment with only tool_calls and no content has nothing to show in the UI
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

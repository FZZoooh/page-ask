import { t, type MessageKey } from '@/lib/i18n';
import { clockTime, formatTime } from '@/lib/format-time.mjs';
import type { StoredMessage, Usage } from '@/lib/chat';
import type { Attachment } from '@/lib/attachments';

export interface Message {
  id: string;
  /**
   * The row id the backend assigned to a locally appended user message. Loaded messages already use
   * the DB id as `id`, but a fresh send needs a stable local key until `meta` reports the server id.
   */
  serverId?: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  selection?: string;
  attachments?: Attachment[];
  reasoning?: string;
  /** Currently streaming in */
  streaming?: boolean;
  /** Server flag: this turn was aborted or the upstream truncated (the answer may be incomplete) */
  aborted?: boolean;
  error?: string;
  ms?: number;
  /** Think + tool phase duration (ms) for the answer segment that follows it */
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

/** One think/tool phase inside a turn; a tool round splits the turn into several of these. */
export interface RoundPhase {
  key: string;
  reasoning: string;
  steps: Message[];
  answers: Message[];
  /** This phase is still running (streaming or a tool is in flight) */
  running: boolean;
  /** Answer text has started: the collapsed block stops saying "thinking" */
  answered: boolean;
  /** Think + tool phase duration (ms), frozen when this phase's answer begins */
  processMs: number | null;
  /** Phase end time (createdAt of the last non-answer message); old rows rely on it for estimates */
  phaseEndAt: number | null;
  /** Where this phase began: the user message or the end of the previous phase */
  startAt: number | null;
}

/** Render model: one turn = user message + one or more think/tool phases with their answers */
export interface Round {
  key: string;
  user: Message | null;
  phases: RoundPhase[];
}

/** Milliseconds → "3.4" (seconds, one decimal); falls back to "0.0" when there is no data */
export function seconds(ms: number | null | undefined): string {
  return ((ms ?? 0) / 1000).toFixed(1);
}

function newPhase(key: string, startAt: number | null): RoundPhase {
  return {
    key,
    reasoning: '',
    steps: [],
    answers: [],
    running: false,
    answered: false,
    processMs: null,
    phaseEndAt: startAt,
    startAt,
  };
}

function phaseEnd(phase: RoundPhase): number | null {
  const last = phase.answers[phase.answers.length - 1];
  return last?.createdAt ?? phase.phaseEndAt ?? phase.startAt;
}

/** Split the flat message stream into turns at each user message; each think/tool round becomes a phase */
export function buildRounds(list: Message[]): Round[] {
  const rounds: Round[] = [];
  const last = () => rounds[rounds.length - 1];

  for (const m of list) {
    if (m.role === 'user') {
      rounds.push({ key: m.id, user: m, phases: [] });
      continue;
    }

    // No user message leads (e.g. recovering mid-turn): synthesize a turn that holds only the answer
    if (!rounds.length) rounds.push({ key: `lead:${m.id}`, user: null, phases: [] });
    const r = last()!;
    let phase = r.phases[r.phases.length - 1] ?? null;

    if (m.role === 'tool') {
      // A tool after answer text starts a new phase; consecutive tools share the current one.
      if (!phase || phase.answered) {
        phase = newPhase(`phase:${m.id}`, phase ? phaseEnd(phase) : (r.user?.createdAt ?? null));
        r.phases.push(phase);
      }
      phase.steps.push(m);
      if (m.createdAt != null) phase.phaseEndAt = m.createdAt;
      if (m.toolState === 'running') phase.running = true;
      continue;
    }

    // assistant: skip segments with only tool_calls and no content — nothing to render
    if (!m.content && !m.reasoning && !m.error && !m.streaming) {
      if (phase && m.createdAt != null) phase.phaseEndAt = m.createdAt;
      continue;
    }
    if (!phase || phase.answered) {
      phase = newPhase(`phase:${m.id}`, phase ? phaseEnd(phase) : (r.user?.createdAt ?? null));
      r.phases.push(phase);
    }
    if (m.reasoning) phase.reasoning += m.reasoning;
    if (m.streaming) phase.running = true;

    if (m.content || m.error) {
      phase.answered = true;
      if (m.processMs != null) {
        phase.processMs = m.processMs;
      } else if (phase.processMs == null) {
        // Old rows have no per-phase processMs: derive it from the segment span when possible.
        const ownSpan =
          m.createdAt != null && phase.phaseEndAt != null ? Math.max(0, m.createdAt - phase.phaseEndAt) : null;
        phase.processMs =
          m.ms != null && ownSpan != null
            ? Math.max(0, m.ms - ownSpan)
            : phase.phaseEndAt != null && phase.startAt != null
              ? Math.max(0, phase.phaseEndAt - phase.startAt)
              : null;
      }
      phase.answers.push(m);
    } else if (m.createdAt != null) {
      phase.phaseEndAt = m.createdAt;
    }
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
  for (let i = r.phases.length - 1; i >= 0; i--) {
    const phase = r.phases[i]!;
    const last = phase.answers[phase.answers.length - 1];
    const end = last?.createdAt ?? phase.phaseEndAt ?? phase.startAt;
    if (end != null) return end;
  }
  return r.user?.createdAt ?? null;
}

const TOOL_LABEL_KEYS: Record<string, MessageKey> = {
  read_page: 'tool.read_page',
  read_file: 'tool.read_file',
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
  if (name === 'read_page' || name === 'read_file') {
    if (name === 'read_page' && args.scope === 'viewport') return t('tool.detail.viewport');
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
    selection: m.selection,
    attachments: m.attachments?.length ? m.attachments : undefined,
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

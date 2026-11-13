// Backend API client: conversation read/write + streaming chat.
// Backend lives at 127.0.0.1:8787 and only accepts chrome-extension://<this extension> origins.
import type { Attachment } from './attachments';
import type { ExtractedPage, SelectionInfo } from './extract';
import { t, tError } from './i18n';
import { baseUrl, type Settings } from './settings';

export interface ConversationMeta {
  id: string;
  url: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Time of the last message; the history list orders by it, falling back to updatedAt when absent */
  lastMessageAt?: number;
  messageCount?: number;
  lastUserText?: string;
}

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  selection?: string;
  reasoning: string;
  createdAt: number;
  tokensIn: number | null;
  tokensOut: number | null;
  ms: number | null;
  /** Time this turn spent thinking + calling tools (ms); only the final answer segment carries it */
  processMs?: number | null;
  /** An assistant segment may carry tool calls (OpenAI format) */
  toolCalls?: ToolCall[] | null;
  /** When role === 'tool': which call it belongs to, which tool ran, what args it got */
  toolFailed?: boolean | null;
  toolCallId?: string | null;
  toolName?: string | null;
  toolArgs?: Record<string, unknown> | null;
  aborted?: boolean;
  /** User rows only: files sent with this question, in display order */
  attachments?: Attachment[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface Conversation extends ConversationMeta {
  messages: StoredMessage[];
  /** Paginated GET only: whether older messages exist and the cursor for the next page */
  hasMore?: boolean;
  nextBefore?: string | null;
}

export interface Usage {
  // Responses API fields
  input_tokens?: number;
  output_tokens?: number;
  output_tokens_details?: { reasoning_tokens?: number };
  // Chat Completions era fields (old conversations still have this shape)
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
}

export type ChatEvent =
  | { type: 'meta'; conversationId: string; messageId: string; model: string }
  | { type: 'reasoning'; delta: string }
  /** processMs is the server-authoritative duration of the current think/tool phase */
  | { type: 'content'; delta: string; processMs?: number }
  | { type: 'replace'; text: string; processMs?: number }
  | { type: 'usage'; usage: Usage }
  | {
      type: 'tool';
      phase: 'start' | 'end';
      id: string;
      name: string;
      args?: Record<string, unknown>;
      /** Only on phase end: UI label, args summary, whether it failed, result length */
      label?: string;
      detail?: string;
      ok?: boolean;
      chars?: number;
    }
  | {
      type: 'done';
      conversationId: string;
      aborted?: boolean;
      message?: {
        id: string;
        content: string;
        reasoning: string;
        ms: number;
        /** Time this turn spent thinking + calling tools (ms) */
        processMs?: number;
        tokensIn?: number | null;
        tokensOut?: number | null;
      };
      usage?: Usage | null;
      totals?: { tokensIn: number; tokensOut: number };
      steps?: number;
      ms?: number;
    }
  | { type: 'error'; message: string; code?: string; params?: Record<string, string | number> }
  /** Title the server generates after the first Q&A round */
  | { type: 'title'; conversationId: string; title: string };

/* ---------------- Basic requests ---------------- */

export function endpoint(settings: Settings, path: string): string {
  return `${baseUrl(settings)}${path}`;
}

/** When the backend's settings.json sets a token, every request must carry the same token */
export function authHeaders(settings: Settings): Record<string, string> {
  const token = settings.token?.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

interface ApiErrorBody {
  error?: string;
  message?: string;
  code?: string;
  params?: Record<string, string | number>;
}

/** Backend error bodies are always { error, message, code, params }: code picks local copy, else status. */
export async function backendErrorText(res: Response): Promise<string> {
  const raw = await res.text().catch(() => '');
  let body: ApiErrorBody | null = null;
  try {
    body = raw ? (JSON.parse(raw) as ApiErrorBody) : null;
  } catch {
    /* not a JSON error body: keep the raw text */
  }
  if (body?.code) return tError(body.code, body.params, body.message ?? body.error);
  const detail = (body?.message ?? body?.error ?? raw).slice(0, 300);
  return t('error.backendStatus', {
    status: res.status,
    detail: detail ? t('error.backendDetail', { detail }) : '',
  });
}

async function httpJson<T>(settings: Settings, path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    // Only requests with a body are JSON; a GET with Content-Type triggers a needless CORS preflight.
    const headers: Record<string, string> = { ...authHeaders(settings) };
    if (init?.body) headers['Content-Type'] = 'application/json';
    res = await fetch(endpoint(settings, path), {
      ...init,
      headers: { ...headers, ...(init?.headers ?? {}) },
    });
  } catch {
    throw new Error(t('error.unreachable', { baseUrl: baseUrl(settings) }));
  }
  if (!res.ok) throw new Error(await backendErrorText(res));
  return (await res.json()) as T;
}

export async function checkHealth(settings: Settings): Promise<{ ok: boolean; model: string; db: string }> {
  return httpJson<{ ok: boolean; model: string; db: string }>(settings, '/health');
}

export async function listConversations(settings: Settings, pageUrl: string): Promise<ConversationMeta[]> {
  const data = await httpJson<{ conversations: ConversationMeta[] }>(
    settings,
    `/conversations?url=${encodeURIComponent(pageUrl)}`,
  );
  return data.conversations;
}

export async function getConversation(
  settings: Settings,
  id: string,
  opts: { limit?: number; before?: string | null } = {},
): Promise<Conversation> {
  const q = new URLSearchParams();
  if (opts.limit) q.set('limit', String(opts.limit));
  if (opts.before) q.set('before', opts.before);
  const query = q.toString();
  const suffix = query ? `?${query}` : '';
  return httpJson<Conversation>(settings, `/conversations/${encodeURIComponent(id)}${suffix}`);
}

export async function deleteConversation(settings: Settings, id: string): Promise<void> {
  await httpJson<{ ok: boolean }>(settings, `/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export interface RecoveredQuestion {
  text: string;
  messageId: string;
  /** Files of the recovered question; the backend returns them to the pending state */
  attachments?: Attachment[];
}

/**
 * Called on conversation load: a trailing unanswered user question (the previous process died
 * mid-turn) comes back from the backend, which deletes it, and the panel refills the composer,
 * so a resend does not leave two identical questions. 409 = nothing to recover or still running → null.
 */
export async function recoverPendingQuestion(settings: Settings, id: string): Promise<RecoveredQuestion | null> {
  let res: Response;
  try {
    res = await fetch(endpoint(settings, `/conversations/${encodeURIComponent(id)}/recover`), {
      method: 'POST',
      headers: authHeaders(settings),
    });
  } catch {
    throw new Error(t('error.unreachable', { baseUrl: baseUrl(settings) }));
  }
  if (res.status === 409) return null;
  if (!res.ok) throw new Error(t('error.backendStatus', { status: res.status, detail: '' }));
  return (await res.json()) as RecoveredQuestion;
}

/* ---------------- Streaming chat ---------------- */

export interface ChatRequest {
  settings: Settings;
  conversationId?: string | null;
  page: Pick<ExtractedPage, 'url' | 'pageUrl' | 'title' | 'markdown' | 'viewport' | 'kind' | 'pages' | 'selection'> & {
    /** Selected text + the paragraph it sits in (lets the model judge tone and what "it" refers to) */
    selectionContext?: SelectionInfo | null;
  };
  /** Screenshot (data URL); used when the model calls the screenshot tool */
  screenshot?: { dataUrl: string; width: number; height: number } | null;
  text: string;
  /** Uploaded attachment ids in display order; omitted on regenerate (the question keeps its files) */
  attachments?: string[];
  /** Regenerate: the backend drops the previous answer (rows after the last user message) and reruns */
  regenerate?: boolean;
  /** Inline edit: the backend rewrites this user message and drops every later row, then reruns from it */
  editMessageId?: string;
  /** UI language: the backend answers and titles in this language instead of always using Chinese */
  locale?: 'zh-CN' | 'en-US';
  signal?: AbortSignal;
}

export async function* streamChat(req: ChatRequest): AsyncGenerator<ChatEvent> {
  let res: Response;
  try {
    res = await fetch(endpoint(req.settings, '/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(req.settings) },
      body: JSON.stringify({
        conversationId: req.conversationId ?? undefined,
        regenerate: req.regenerate ? true : undefined,
        editMessageId: req.editMessageId,
        locale: req.locale,
        page: {
          url: req.page.url,
          pageUrl: req.page.pageUrl,
          title: req.page.title,
          markdown: req.page.markdown,
          viewport: req.page.viewport,
          kind: req.page.kind ?? 'web',
          pages: req.page.pages,
          selection: req.page.selection ?? '',
          selectionContext: req.page.selectionContext ?? null,
          screenshot: req.screenshot?.dataUrl,
          screenshotWidth: req.screenshot?.width,
          screenshotHeight: req.screenshot?.height,
        },
        text: req.text,
        attachments: req.attachments,
      }),
      signal: req.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    throw new Error(t('error.unreachable', { baseUrl: baseUrl(req.settings) }));
  }

  if (!res.ok || !res.body) {
    throw new Error(await backendErrorText(res));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // SSE frames cross a process boundary; validate the fields we use instead of trusting the cast.
  const record = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
  const count = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE spec allows CRLF; normalize after appending so a CR/LF pair split across chunks is joined first.
      buffer = buffer.replace(/\r\n/g, '\n');

      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const event = block.match(/^event: (.+)$/m)?.[1];
        const raw = block.match(/^data: (.+)$/m)?.[1];
        if (!event || !raw) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue;
        }
        const payload = record(parsed);
        if (!payload) continue;

        switch (event) {
          case 'meta': {
            const conversationId = text(payload.conversationId);
            if (!conversationId) break;
            yield {
              type: 'meta',
              conversationId,
              messageId: text(payload.messageId) ?? text(payload.userMessageId) ?? '',
              model: text(payload.model) ?? '',
            };
            break;
          }
          case 'reasoning': {
            const delta = text(payload.delta);
            if (delta) yield { type: 'reasoning', delta };
            break;
          }
          case 'content': {
            const delta = text(payload.delta);
            // The server freezes phaseMs on the first content frame. Dropping it here made the live
            // summary fall back to an untimed phase, which rendered as "0.0s" while the answer streamed.
            if (delta) yield { type: 'content', delta, processMs: count(payload.processMs) };
            break;
          }
          case 'replace': {
            const finalText = text(payload.text);
            if (finalText !== undefined) {
              yield { type: 'replace', text: finalText, processMs: count(payload.processMs) };
            }
            break;
          }
          case 'usage':
            yield { type: 'usage', usage: payload as Usage };
            break;
          case 'tool': {
            const id = text(payload.id);
            const name = text(payload.name);
            if (!id || !name) break;
            yield {
              type: 'tool',
              phase: payload.phase === 'end' ? 'end' : 'start',
              id,
              name,
              args: record(payload.args) ?? undefined,
              label: text(payload.label),
              detail: text(payload.detail),
              ok: typeof payload.ok === 'boolean' ? payload.ok : undefined,
              chars: count(payload.chars),
            };
            break;
          }
          case 'done': {
            const conversationId = text(payload.conversationId);
            if (!conversationId) break;
            const msg = record(payload.message);
            const message =
              msg && text(msg.id) !== undefined && text(msg.content) !== undefined && text(msg.reasoning) !== undefined
                ? {
                    id: text(msg.id) as string,
                    content: text(msg.content) as string,
                    reasoning: text(msg.reasoning) as string,
                    ms: count(msg.ms) ?? 0,
                    processMs: count(msg.processMs),
                    tokensIn: count(msg.tokensIn) ?? null,
                    tokensOut: count(msg.tokensOut) ?? null,
                  }
                : undefined;
            yield {
              type: 'done',
              conversationId,
              aborted: payload.aborted === true,
              message,
              usage: record(payload.usage) ? (payload.usage as Usage) : null,
              totals: record(payload.totals)
                ? (payload.totals as { tokensIn: number; tokensOut: number })
                : undefined,
              steps: count(payload.steps),
              ms: count(payload.ms),
            };
            break;
          }
          case 'error':
            yield {
              type: 'error',
              message: text(payload.message) ?? t('error.unknown'),
              code: text(payload.code),
              params: record(payload.params) ? (payload.params as Record<string, string | number>) : undefined,
            };
            break;
          case 'title': {
            const conversationId = text(payload.conversationId);
            const title = text(payload.title);
            if (conversationId && title) yield { type: 'title', conversationId, title };
            break;
          }
        }
      }
    }
  } finally {
    // Close the connection even when the caller breaks early; do not leave the auto-title stream open
    reader.cancel().catch(() => {});
  }
}

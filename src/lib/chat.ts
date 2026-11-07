// 后端接口客户端：会话读写 + 流式对话。
// 后端在 127.0.0.1:8787，只认 chrome-extension://<本扩展> 的 Origin。
import type { ExtractedPage, SelectionInfo } from './extract';
import { t, tError } from './i18n';
import { baseUrl, type Settings } from './settings';

export interface ConversationMeta {
  id: string;
  url: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** 最后一条消息的时间；历史列表按它显示，缺省时回退到 updatedAt */
  lastMessageAt?: number;
  messageCount?: number;
  lastUserText?: string;
}

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  reasoning: string;
  createdAt: number;
  tokensIn: number | null;
  tokensOut: number | null;
  ms: number | null;
  /** 本轮「思考 + 工具调用」阶段的耗时（毫秒）；只有最终那段回答带 */
  processMs?: number | null;
  /** assistant 段可能带工具调用（OpenAI 格式） */
  toolCalls?: ToolCall[] | null;
  /** role === 'tool' 时：它是哪次调用、哪个工具、参数是什么 */
  toolFailed?: boolean | null;
  toolCallId?: string | null;
  toolName?: string | null;
  toolArgs?: Record<string, unknown> | null;
  aborted?: boolean;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface Conversation extends ConversationMeta {
  messages: StoredMessage[];
}

export interface Usage {
  // Responses API 的字段
  input_tokens?: number;
  output_tokens?: number;
  output_tokens_details?: { reasoning_tokens?: number };
  // Chat Completions 时代的字段（历史会话里仍是这个形状）
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
}

export type ChatEvent =
  | { type: 'meta'; conversationId: string; messageId: string; model: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'content'; delta: string }
  | { type: 'replace'; text: string }
  | { type: 'usage'; usage: Usage }
  | {
      type: 'tool';
      phase: 'start' | 'end';
      id: string;
      name: string;
      args?: Record<string, unknown>;
      /** end 阶段才有：给 UI 的文字标签、参数摘要、是否失败、返回长度 */
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
        /** 本轮「思考 + 工具调用」阶段耗时（毫秒） */
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
  /** 第一轮问答后服务端自动起的标题 */
  | { type: 'title'; conversationId: string; title: string };

/* ---------------- 基础请求 ---------------- */

function endpoint(settings: Settings, path: string): string {
  return `${baseUrl(settings)}${path}`;
}

/** 后端设了 PAGEASK_TOKEN 时，所有请求都要带同一个令牌 */
function authHeaders(settings: Settings): Record<string, string> {
  const token = settings.token?.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

interface ApiErrorBody {
  error?: string;
  message?: string;
  code?: string;
  params?: Record<string, string | number>;
}

/** 后端的错误体统一是 { error, message, code, params }：有 code 走本地文案，否则拼状态码。 */
async function backendErrorText(res: Response): Promise<string> {
  const raw = await res.text().catch(() => '');
  let body: ApiErrorBody | null = null;
  try {
    body = raw ? (JSON.parse(raw) as ApiErrorBody) : null;
  } catch {
    /* 非 JSON 错误体，保留原文 */
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
    res = await fetch(endpoint(settings, path), {
      ...init,
      headers: { 'Content-Type': 'application/json', ...authHeaders(settings), ...(init?.headers ?? {}) },
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

export async function getConversation(settings: Settings, id: string): Promise<Conversation> {
  return httpJson<Conversation>(settings, `/conversations/${encodeURIComponent(id)}`);
}

export async function deleteConversation(settings: Settings, id: string): Promise<void> {
  await httpJson<{ ok: boolean }>(settings, `/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export interface RecoveredQuestion {
  text: string;
  messageId: string;
}

/**
 * 读取会话时调用：如果最后一条是「没有回答的 user 提问」（上次进程中途退出），
 * 后端把它取回并删掉，侧栏填进输入框，用户重发后不会出现两条一样的提问。
 * 409 表示没有可恢复的提问，或这一轮还在生成，返回 null。
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

/* ---------------- 流式对话 ---------------- */

export interface ChatRequest {
  settings: Settings;
  conversationId?: string | null;
  page: Pick<ExtractedPage, 'url' | 'title' | 'markdown' | 'viewport' | 'kind' | 'pages' | 'selection'> & {
    /** 选中的文字 + 它所在的段落（让模型能判断语气/指代） */
    selectionContext?: SelectionInfo | null;
  };
  /** 截图（data URL）；模型调用 screenshot 工具时会用到 */
  screenshot?: { dataUrl: string; width: number; height: number } | null;
  text: string;
  /** 重新生成：后端会删掉上一轮的回答（最后一条 user 消息之后的行）再重跑 */
  regenerate?: boolean;
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
        page: {
          url: req.page.url,
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

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const event = block.match(/^event: (.+)$/m)?.[1];
      const raw = block.match(/^data: (.+)$/m)?.[1];
      if (!event || !raw) continue;

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }

      switch (event) {
        case 'meta':
          yield {
            type: 'meta',
            conversationId: String(payload.conversationId ?? ''),
            messageId: String(payload.userMessageId ?? ''),
            model: String(payload.model ?? ''),
          };
          break;
        case 'reasoning':
          yield { type: 'reasoning', delta: String(payload.delta ?? '') };
          break;
        case 'content':
          yield { type: 'content', delta: String(payload.delta ?? '') };
          break;
        case 'replace':
          yield { type: 'replace', text: String(payload.text ?? '') };
          break;
        case 'usage':
          yield { type: 'usage', usage: payload as Usage };
          break;
        case 'tool':
          yield {
            type: 'tool',
            phase: payload.phase === 'end' ? 'end' : 'start',
            id: String(payload.id ?? ''),
            name: String(payload.name ?? ''),
            args: (payload.args as Record<string, unknown> | undefined) ?? undefined,
            label: typeof payload.label === 'string' ? payload.label : undefined,
            detail: typeof payload.detail === 'string' ? payload.detail : undefined,
            ok: typeof payload.ok === 'boolean' ? payload.ok : undefined,
            chars: typeof payload.chars === 'number' ? payload.chars : undefined,
          };
          break;
        case 'done':
          yield {
            type: 'done',
            conversationId: String(payload.conversationId ?? ''),
            aborted: payload.aborted === true,
            message: payload.message as
              | { id: string; content: string; reasoning: string; ms: number; processMs?: number }
              | undefined,
            usage: (payload.usage as Usage | null) ?? null,
            totals: payload.totals as { tokensIn: number; tokensOut: number } | undefined,
            steps: typeof payload.steps === 'number' ? payload.steps : undefined,
            ms: typeof payload.ms === 'number' ? payload.ms : undefined,
          };
          break;
        case 'error':
          yield {
            type: 'error',
            message: String(payload.message ?? t('error.unknown')),
            code: typeof payload.code === 'string' ? payload.code : undefined,
            params:
              payload.params && typeof payload.params === 'object'
                ? (payload.params as Record<string, string | number>)
                : undefined,
          };
          break;
        case 'title':
          yield {
            type: 'title',
            conversationId: String(payload.conversationId ?? ''),
            title: String(payload.title ?? ''),
          };
          break;
      }
    }
    }
  } finally {
    // 调用方中途 break 时也要把连接收掉，别让服务端继续挂着自动标题的连接
    reader.cancel().catch(() => {});
  }
}

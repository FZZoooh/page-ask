import type { ChatEvent, Usage } from '../../lib/chat';
import type { Message } from './messages';

export interface ChatStreamState {
  targetId: string | null;
  conversationId: string | null;
  localUserId: string | null;
  phaseMs: number | null;
  phaseAnswered: boolean;
  contentBuf: string;
  reasoningBuf: string;
  sawDone: boolean;
  sawError: boolean;
}

export interface ChatStreamIO {
  createId: () => string;
  toolLabel: (name: string) => string;
  toolDetail: (name: string, args: Record<string, unknown> | null) => string;
  errorText: (event: Extract<ChatEvent, { type: 'error' }>) => string;
}

export type ChatAction =
  | { type: 'append'; id: string; content: string; reasoning: string; processMs: number | null }
  | { type: 'create'; id: string }
  | { type: 'replace'; id: string; text: string; reasoning: string; processMs: number | null }
  | { type: 'usage'; id: string | null; usage: Usage }
  | { type: 'meta'; localUserId: string; messageId: string }
  | { type: 'toolStart'; closeId: string | null; tool: Message }
  | { type: 'toolEnd'; event: Extract<ChatEvent, { type: 'tool' }> }
  | { type: 'done'; targetId: string | null; event: Extract<ChatEvent, { type: 'done' }> }
  | { type: 'error'; targetId: string | null; error: string }
  | { type: 'failure'; targetId: string | null; message: string };

export interface ChatTransition {
  state: ChatStreamState;
  actions: ChatAction[];
}

export function createChatStreamState(
  targetId: string,
  conversationId: string | null,
  localUserId: string | null,
): ChatStreamState {
  return {
    targetId,
    conversationId,
    localUserId,
    phaseMs: null,
    phaseAnswered: false,
    contentBuf: '',
    reasoningBuf: '',
    sawDone: false,
    sawError: false,
  };
}

function flushInto(state: ChatStreamState, actions: ChatAction[]): ChatStreamState {
  const next = { ...state, contentBuf: '', reasoningBuf: '' };
  if ((!state.contentBuf && !state.reasoningBuf) || !state.targetId) return next;
  actions.push({
    type: 'append',
    id: state.targetId,
    content: state.contentBuf,
    reasoning: state.reasoningBuf,
    processMs: state.phaseMs,
  });
  return next;
}

export function flushChatStream(state: ChatStreamState): ChatTransition {
  const actions: ChatAction[] = [];
  return { state: flushInto(state, actions), actions };
}

function ensureTarget(state: ChatStreamState, actions: ChatAction[], createId: () => string): ChatStreamState {
  if (state.targetId) return state;
  const targetId = createId();
  actions.push({ type: 'create', id: targetId });
  return { ...state, targetId };
}

export function reduceChatEvent(state: ChatStreamState, event: ChatEvent, io: ChatStreamIO): ChatTransition {
  const actions: ChatAction[] = [];
  let next = state;

  switch (event.type) {
    case 'meta':
      next = { ...next, conversationId: event.conversationId };
      if (next.localUserId) {
        actions.push({ type: 'meta', localUserId: next.localUserId, messageId: event.messageId });
      }
      break;
    case 'content':
      next = ensureTarget(next, actions, io.createId);
      next = {
        ...next,
        phaseMs: event.processMs ?? next.phaseMs,
        phaseAnswered: true,
        contentBuf: next.contentBuf + event.delta,
      };
      break;
    case 'reasoning':
      next = ensureTarget(next, actions, io.createId);
      next = { ...next, reasoningBuf: next.reasoningBuf + event.delta };
      break;
    case 'replace': {
      next = ensureTarget(next, actions, io.createId);
      next = {
        ...next,
        phaseMs: event.processMs ?? next.phaseMs,
        phaseAnswered: true,
      };
      actions.push({
        type: 'replace',
        id: next.targetId!,
        text: event.text,
        reasoning: next.reasoningBuf,
        processMs: next.phaseMs,
      });
      next = { ...next, contentBuf: '', reasoningBuf: '' };
      break;
    }
    case 'usage':
      actions.push({ type: 'usage', id: next.targetId, usage: event.usage });
      break;
    case 'tool':
      if (event.phase === 'start') {
        next = flushInto(next, actions);
        const closeId = next.targetId;
        if (next.phaseAnswered) next = { ...next, phaseMs: null, phaseAnswered: false };
        next = { ...next, targetId: null };
        actions.push({
          type: 'toolStart',
          closeId,
          tool: {
            id: event.id,
            role: 'tool',
            content: '',
            toolName: event.name,
            toolLabel: io.toolLabel(event.name),
            toolDetail: io.toolDetail(event.name, event.args ?? null),
            toolArgs: event.args,
            toolState: 'running',
          },
        });
      } else {
        actions.push({ type: 'toolEnd', event });
      }
      break;
    case 'done':
      next = flushInto(next, actions);
      next = { ...next, sawDone: true };
      actions.push({ type: 'done', targetId: next.targetId, event });
      break;
    case 'error':
      next = flushInto(next, actions);
      next = ensureTarget(next, actions, io.createId);
      next = { ...next, sawError: true };
      actions.push({ type: 'error', targetId: next.targetId, error: io.errorText(event) });
      break;
    case 'title':
      break;
  }

  return { state: next, actions };
}

export function failChatStream(
  state: ChatStreamState,
  message: string,
  createId: () => string,
): ChatTransition {
  const actions: ChatAction[] = [];
  const next = ensureTarget(flushInto(state, actions), actions, createId);
  actions.push({ type: 'failure', targetId: next.targetId, message });
  return { state: next, actions };
}

export function applyChatActions(messages: Message[], actions: ChatAction[]): Message[] {
  let next = messages;

  for (const action of actions) {
    switch (action.type) {
      case 'append':
        next = next.map((m) =>
          m.id === action.id
            ? {
                ...m,
                content: m.content + action.content,
                reasoning: (m.reasoning ?? '') + action.reasoning,
                ...(action.processMs != null ? { processMs: m.processMs ?? action.processMs } : {}),
              }
            : m,
        );
        break;
      case 'create':
        next = [...next, { id: action.id, role: 'assistant', content: '', reasoning: '', streaming: true }];
        break;
      case 'replace':
        next = next.map((m) =>
          m.id === action.id
            ? {
                ...m,
                content: action.text,
                reasoning: (m.reasoning ?? '') + action.reasoning,
                processMs: m.processMs ?? action.processMs ?? undefined,
              }
            : m,
        );
        break;
      case 'usage':
        next = next.map((m) => (m.id === action.id ? { ...m, usage: action.usage } : m));
        break;
      case 'meta':
        next = next.map((m) => (m.id === action.localUserId ? { ...m, serverId: action.messageId } : m));
        break;
      case 'toolStart':
        next = next.map((m) => (m.id === action.closeId ? { ...m, streaming: false } : m));
        next.push(action.tool);
        break;
      case 'toolEnd': {
        const event = action.event;
        next = next.map((m) =>
          m.id === event.id
            ? {
                ...m,
                toolState: 'done',
                toolOk: event.ok !== false,
                toolChars: event.chars,
                toolLabel: event.label || m.toolLabel,
                toolDetail: event.detail || m.toolDetail,
              }
            : m,
        );
        break;
      }
      case 'done': {
        const event = action.event;
        next = next.map((m) => {
          if (m.id !== action.targetId) return m.streaming ? { ...m, streaming: false } : m;
          return {
            ...m,
            streaming: false,
            ms: event.message?.ms ?? event.ms,
            processMs: event.message?.processMs ?? m.processMs,
            aborted: event.aborted === true || m.aborted,
            tokensIn: event.message?.tokensIn ?? event.totals?.tokensIn ?? m.tokensIn,
            tokensOut: event.message?.tokensOut ?? event.totals?.tokensOut ?? m.tokensOut,
            usage: event.usage ?? m.usage,
          };
        });
        break;
      }
      case 'error':
        next = next.map((m) => (m.id === action.targetId ? { ...m, streaming: false, error: action.error } : m));
        break;
      case 'failure': {
        const cleaned = next.filter((m) => m.role !== 'tool' || m.toolState === 'done');
        const hasTarget = cleaned.some((m) => m.id === action.targetId);
        next = hasTarget
          ? cleaned.map((m) =>
              m.id === action.targetId
                ? {
                    ...m,
                    streaming: false,
                    error: action.message,
                  }
                : m.streaming
                  ? { ...m, streaming: false }
                  : m,
            )
          : cleaned.map((m) => (m.streaming ? { ...m, streaming: false } : m));
        break;
      }
    }
  }

  return next;
}

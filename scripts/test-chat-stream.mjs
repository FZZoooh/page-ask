import assert from 'node:assert/strict';
import {
  applyChatActions,
  createChatStreamState,
  failChatStream,
  flushChatStream,
  reduceChatEvent,
} from '../src/entrypoints/sidepanel/chat-stream.ts';

let generated = 0;
const io = {
  createId: () => `generated-${++generated}`,
  toolLabel: (name) => `label:${name}`,
  toolDetail: (name, args) => `${name}:${JSON.stringify(args)}`,
  errorText: (event) => `error:${event.code}`,
};
const assistant = (id = 'a1') => ({ id, role: 'assistant', content: '', reasoning: '', streaming: true });
const user = { id: 'u1', role: 'user', content: 'question' };
const transition = (state, event) => reduceChatEvent(state, event, io);

{
  const original = [user, assistant()];
  let state = createChatStreamState('a1', null, 'u1');
  const content = transition(state, { type: 'content', delta: 'hello', processMs: 120 });
  state = content.state;
  assert.equal(content.actions.length, 0);
  const reasoning = transition(state, { type: 'reasoning', delta: 'thinking' });
  state = reasoning.state;
  const flushed = flushChatStream(state);
  const messages = applyChatActions(original, flushed.actions);
  assert.equal(messages[1].content, 'hello');
  assert.equal(messages[1].reasoning, 'thinking');
  assert.equal(messages[1].processMs, 120);
  assert.equal(original[1].content, '');
  assert.equal(flushed.state.contentBuf, '');
  assert.equal(flushed.state.reasoningBuf, '');
}

{
  let state = createChatStreamState('a1', null, null);
  state = transition(state, { type: 'content', delta: 'draft', processMs: 100 }).state;
  state = transition(state, { type: 'reasoning', delta: 'reason' }).state;
  const replaced = transition(state, { type: 'replace', text: 'final', processMs: 200 });
  const messages = applyChatActions([assistant()], replaced.actions);
  assert.equal(messages[0].content, 'final');
  assert.equal(messages[0].reasoning, 'reason');
  assert.equal(messages[0].processMs, 200);
  assert.equal(replaced.state.contentBuf, '');
  assert.equal(replaced.state.reasoningBuf, '');
}

{
  let state = createChatStreamState('a1', null, 'u1');
  let messages = [user, assistant()];
  const meta = transition(state, { type: 'meta', conversationId: 'c1', messageId: 'db-u1', model: 'm' });
  state = meta.state;
  messages = applyChatActions(messages, meta.actions);
  assert.equal(messages[0].serverId, 'db-u1');
  assert.equal(state.conversationId, 'c1');

  state = transition(state, { type: 'content', delta: 'A', processMs: 100 }).state;
  const started = transition(state, {
    type: 'tool',
    phase: 'start',
    id: 't1',
    name: 'read_page',
    args: { scope: 'viewport' },
  });
  state = started.state;
  messages = applyChatActions(messages, started.actions);
  assert.equal(messages[1].content, 'A');
  assert.equal(messages[1].streaming, false);
  assert.equal(messages[2].toolState, 'running');
  assert.equal(state.targetId, null);
  assert.equal(state.phaseMs, null);
  assert.equal(state.phaseAnswered, false);

  const ended = transition(state, {
    type: 'tool',
    phase: 'end',
    id: 't1',
    name: 'read_page',
    ok: true,
    chars: 42,
    label: 'Read',
  });
  state = ended.state;
  messages = applyChatActions(messages, ended.actions);
  assert.equal(messages[2].toolState, 'done');
  assert.equal(messages[2].toolChars, 42);
  assert.equal(messages[2].toolLabel, 'Read');

  const secondContent = transition(state, { type: 'content', delta: 'B', processMs: 300 });
  state = secondContent.state;
  messages = applyChatActions(messages, secondContent.actions);
  const done = transition(state, {
    type: 'done',
    conversationId: 'c1',
    message: { id: 'db-a2', content: 'B', reasoning: '', ms: 500, tokensIn: 7, tokensOut: 3 },
    usage: { input_tokens: 7, output_tokens: 3 },
  });
  messages = applyChatActions(messages, done.actions);
  assert.equal(done.state.sawDone, true);
  assert.equal(messages.length, 4);
  assert.equal(messages[3].id, 'generated-1');
  assert.equal(messages[3].content, 'B');
  assert.equal(messages[3].processMs, 300);
  assert.equal(messages[3].ms, 500);
  assert.equal(messages[3].tokensIn, 7);
  assert.equal(messages[3].tokensOut, 3);
  assert.equal(messages.some((message) => message.streaming), false);
}

{
  let state = createChatStreamState('a1', null, null);
  state = { ...state, targetId: null };
  const failed = transition(state, { type: 'error', code: 'upstream.empty', message: 'fallback' });
  const messages = applyChatActions([], failed.actions);
  assert.equal(failed.state.sawError, true);
  assert.equal(messages[0].id, 'generated-2');
  assert.equal(messages[0].error, 'error:upstream.empty');
  assert.equal(messages[0].streaming, false);
}

{
  const state = createChatStreamState('a1', null, null);
  const stopped = failChatStream(state, 'Stopped', io.createId);
  const messages = applyChatActions([user, assistant()], stopped.actions);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].error, 'Stopped');
  assert.equal(messages[1].streaming, false);
  const partial = applyChatActions([{ ...assistant(), content: 'partial' }], stopped.actions);
  assert.equal(partial[0].content, 'partial');
  assert.equal(partial[0].error, 'Stopped');
  assert.equal(partial[0].streaming, false);
}

{
  const state = { ...createChatStreamState('a1', null, null), targetId: null };
  const stopped = failChatStream(state, 'Stopped', io.createId);
  const messages = applyChatActions(
    [
      user,
      { ...assistant(), content: 'I will read the page.', streaming: false },
      { id: 't1', role: 'tool', content: 'page', toolState: 'done' },
    ],
    stopped.actions,
  );
  assert.equal(messages.length, 4);
  assert.equal(messages[3].role, 'assistant');
  assert.equal(messages[3].content, '');
  assert.equal(messages[3].error, 'Stopped');
  assert.equal(messages[3].streaming, false);
}

{
  const state = createChatStreamState('a1', null, null);
  const failed = failChatStream(state, 'Stopped', io.createId);
  const messages = applyChatActions(
    [assistant(), { id: 't1', role: 'tool', content: '', toolState: 'running' }],
    failed.actions,
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0].error, 'Stopped');
  assert.equal(messages[0].streaming, false);
  const partial = applyChatActions([{ ...assistant(), content: 'partial' }], failed.actions);
  assert.equal(partial[0].error, 'Stopped');
}

console.log('chat-stream: all checks passed');

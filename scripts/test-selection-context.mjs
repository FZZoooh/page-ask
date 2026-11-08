#!/usr/bin/env node
/**
 * Verify whether "selected text + its surrounding paragraph" actually helps the model.
 *
 * Usage: node scripts/test-selection-context.mjs [baseUrl]
 *
 * Scenario: the selection is nothing but "it" plus one short phrase and is ambiguous on its own;
 * the paragraph context reveals what "it" refers to. Compare a selection-only request with a
 * selection-plus-context one: does the model need extra tool calls, and is the answer accurate?
 */

import { readSettings } from '../server/settings.mjs';

const BASE = process.argv[2] ?? `http://127.0.0.1:${readSettings().port}`;

const PAGE_TEXT = [
  '浏览器扩展侧栏开发入门',
  '作者：张三 · 2026 年 11 月 3 日 · 预计阅读 6 分钟',
  'Manifest V3 引入了 chrome.sidePanel 接口，让扩展可以在浏览器右侧常驻一个面板。',
  '与弹出式 popup 不同，侧栏不会在失去焦点时关闭，因此更适合承载多轮对话这类长时间交互。',
  '读取页面依赖 scripting 权限，只有在用户点击扩展图标时，浏览器才会把那一个标签页的访问权临时授予扩展。',
  '这就是 activeTab 的设计意图——最小权限。',
].join('\n');

const CONTEXT =
  '与弹出式 popup 不同，侧栏不会在失去焦点时关闭，因此更适合承载多轮对话这类长时间交互。读取页面依赖 scripting 权限，只有在用户点击扩展图标时，浏览器才会把那一个标签页的访问权临时授予扩展。这就是 activeTab 的设计意图——最小权限。';

const SELECTION = '这就是 activeTab 的设计意图——最小权限。';
const AT = CONTEXT.indexOf(SELECTION);

const QUESTION = '为什么说「它」更合适？「它」指的是什么？';

function makeBody(withContext) {
  return {
    model: 'deepseek-flash',
    text: QUESTION,
    page: {
      url: 'http://127.0.0.1:8811/article.html',
      title: '浏览器扩展侧栏开发入门',
      markdown: PAGE_TEXT,
      kind: 'web',
      selection: SELECTION,
      selectionContext: withContext
        ? { context: CONTEXT, start: AT, end: AT + SELECTION.length }
        : null,
    },
  };
}

async function run(withContext) {
  const res = await fetch(`${BASE}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(makeBody(withContext)),
  });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  const tools = [];
  let answer = '';
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = raw.split('\n');
      const name = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
      const line = lines.find((l) => l.startsWith('data:'));
      if (!name || !line) continue;
      let ev;
      try {
        ev = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      if (name === 'tool') {
        if (ev.phase === 'start') tools.push(ev.label ?? ev.name ?? 'tool');
      } else if (name === 'content') {
        answer += ev.delta ?? '';
      }
    }
  }
  return { tools, answer: answer.trim() };
}

function verdict(r) {
  const said = r.answer.replace(/\s+/g, ' ');
  const mentions = /弹出|popup|不关闭|常驻|多轮/.test(said);
  return {
    tools: r.tools.length,
    talksAboutPopup: mentions,
    preview: said.slice(0, 80),
  };
}

const withCtx = await run(true);
const without = await run(false);

console.log('== 带上下文 ==');
console.log(JSON.stringify(verdict(withCtx), null, 2));
console.log('== 不带上下文 ==');
console.log(JSON.stringify(verdict(without), null, 2));

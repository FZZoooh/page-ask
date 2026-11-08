import assert from 'node:assert/strict';
import { splitStreamingMarkdown } from '../src/lib/markdown-stream.mjs';

function check(name, input, blocks, tail) {
  const got = splitStreamingMarkdown(input);
  assert.deepEqual(got.blocks, blocks, `${name}: blocks`);
  assert.equal(got.tail, tail, `${name}: tail`);
}

check('no boundary', 'hello', [], 'hello');
check('one completed paragraph', 'hello\n\nwor', ['hello'], 'wor');
check('two completed paragraphs', 'a\n\nb\n\n', ['a', 'b'], '');

check(
  'fenced code keeps blank lines',
  'intro\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nafter',
  ['intro', '```js\nconst a = 1;\n\nconst b = 2;\n```'],
  'after',
);

check(
  'unclosed fence stays in the tail',
  'intro\n\n```js\nconst a = 1;',
  ['intro'],
  '```js\nconst a = 1;',
);

check(
  'display math keeps blank lines',
  'intro\n\n$$\nx = 1\n\ny = 2\n$$\n\ntail',
  ['intro', '$$\nx = 1\n\ny = 2\n$$'],
  'tail',
);

check(
  'single-line math is not a block opener',
  'intro\n\n$$x = 1$$\n\ntail',
  ['intro', '$$x = 1$$'],
  'tail',
);

check('loose list merges', '- one\n\n- two\n\n', ['- one\n\n- two'], '');
check('ordered list merges', '1. one\n\n2. two\n\n', ['1. one\n\n2. two'], '');
check('blockquote merges', '> one\n\n> two\n\n', ['> one\n\n> two'], '');
check('list then paragraph is not merged', '- one\n\nplain\n\n', ['- one', 'plain'], '');
check('nested list stays with its item', '- one\n  - nested\n\n- two\n\n', ['- one\n  - nested\n\n- two'], '');

console.log('markdown-stream: all checks passed');

import assert from 'node:assert/strict';
import { normalizeDisplayMath, splitStreamingMarkdown } from '../src/lib/markdown-stream.mjs';

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

function normalized(name, input, expected) {
  assert.equal(normalizeDisplayMath(input), expected, name);
}

normalized('already normalized is unchanged', '$$\nx = 1\n$$', '$$\nx = 1\n$$');
normalized('single-line standalone becomes a display block', '$$x = 1$$', '$$\nx = 1\n$$');
normalized('mid-line pair stays inline', 'where $$x = 1$$ holds', 'where $$x = 1$$ holds');
normalized('closing delimiter at end of line becomes a display block', '$$x$$\n\ntail', '$$\nx\n$$\n\ntail');
normalized(
  'opening delimiter glued to the formula',
  "$$u'=\\frac{1}{x}\n=y$$",
  "$$\nu'=\\frac{1}{x}\n=y\n$$",
);
normalized('text after the closing delimiter forces a block', '$$x$$ trailing', '$$\nx\n$$\n trailing');
normalized('inline single-dollar math is untouched', 'the value $x + y$ stays', 'the value $x + y$ stays');
normalized('fenced code keeps dollar pairs', '```tex\n$$x$$\n```', '```tex\n$$x$$\n```');
normalized('inline code keeps dollar pairs', 'use `$$x$$` here', 'use `$$x$$` here');
normalized('escaped dollars are untouched', '\\$\\$not math\\$\\$', '\\$\\$not math\\$\\$');
normalized(
  'reported formula',
  "$$u'=\\frac{\\dfrac{1}{1+x}\\cdot x-\\ln(1+x)\\cdot 1}{x^{2}}\n=\\frac{\\dfrac{x}{1+x}-\\ln(1+x)}{x^{2}}$$",
  "$$\nu'=\\frac{\\dfrac{1}{1+x}\\cdot x-\\ln(1+x)\\cdot 1}{x^{2}}\n=\\frac{\\dfrac{x}{1+x}-\\ln(1+x)}{x^{2}}\n$$",
);

console.log('markdown-stream: all checks passed');

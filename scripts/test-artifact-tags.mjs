import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { artifactName, remarkArtifactTags, splitArtifactMarkdown } from '../src/lib/artifact-tags.mjs';
import { normalizeDisplayMath } from '../src/lib/markdown-stream.mjs';

const tag = '<artifact name="report.md"/>';
const plugins = [remarkArtifactTags, remarkGfm, remarkMath, remarkBreaks];
function render(text, enabled = true) {
  const names = [];
  const html = renderToStaticMarkup(createElement(Markdown, {
    remarkPlugins: enabled ? plugins : plugins.slice(1),
    components: {
      div: ({ node, children }) => {
        const name = node.properties['data-artifact-name'];
        if (typeof name === 'string') names.push(name);
        return createElement('div', {}, children);
      },
    },
  }, normalizeDisplayMath(text)));
  return { names, html };
}
function rendered(text, streaming = false) {
  const { blocks, tail } = splitArtifactMarkdown(text);
  const parts = [...blocks, ...(!streaming && tail ? [tail] : [])].map((block) => render(block));
  return { names: parts.flatMap((part) => part.names), html: parts.map((part) => part.html).join('') };
}

assert.equal(artifactName(tag), 'report.md');
assert.equal(artifactName('   <artifact name="报告 & notes.HTML"/>  \r'), '报告 & notes.HTML');
for (const invalid of [
  'x ' + tag, tag + ' x', '    ' + tag, '\t' + tag, '<artifact name=""/>',
  '<artifact name="../x"/>', '<artifact name=".."/>', '<artifact name="a\\b"/>',
  '<artifact name="report.md" onclick="x"/>', '<artifact name="report.md">',
  '<artifact name="report.md"', '<artifact name="report.md"/ >',
]) assert.equal(artifactName(invalid), null, invalid);

for (const valid of [
  tag, '   ' + tag, `# Report\n\n${tag}\n\n**After**`,
  `Before\n${tag}\nAfter`, `${tag}\n**After**`, `${tag}\n${tag}`, `${tag}\r\n\r\nAfter`,
]) assert.ok(rendered(valid).names.length > 0, valid);
assert.deepEqual(rendered(`${tag}\n${tag}`).names, ['report.md', 'report.md']);
assert.match(rendered(`${tag}\n**After**`).html, /<strong>After<\/strong>/);
assert.match(rendered(`Before\n${tag}\nAfter`).html, /<p>Before<\/p>\s*<div><\/div>\s*<p>After<\/p>/);
assert.deepEqual(render(tag, false).names, []);

const forbidden = [
  `Inline ${tag} text`, `\\${tag}`, `\`${tag}\``,
  `\`start\n${tag}\nend\``, `**start\n${tag}\nend**`,
  `    ${tag}`, `\t${tag}`, `    code\n\n    ${tag}`,
  ...['```', '```html', '```markdown', '~~~', '~~~html', '~~~~js'].map((fence) =>
    `${fence}\n\n${tag}\n\n${fence.startsWith('`') ? '```' : '~~~~'}`),
  `\`\`\`\`html\n\`\`\`\n\n${tag}\n\n\`\`\`\``,
  `~~~html\n~~~not-a-closer\n\n${tag}\n~~~`,
  `- item\n\n    \`\`\`html\n\n    ${tag}\n    \`\`\``,
  `<!--\n\n${tag}\n\n-->`, `<?processing\n\n${tag}\n\n?>`,
  `<![CDATA[\n\n${tag}\n\n]]>`, `<!DOCTYPE\n\n${tag}\n>`,
  ...['script', 'pre', 'style', 'textarea'].map((name) => `<${name}>\n\n${tag}\n\n</${name}>`),
  `<div>\n${tag}\n</div>`, `<custom-element>\n${tag}\n</custom-element>`,
  `<div>\n\n${tag}\n\n</div>`, `<custom-element>\n\n${tag}\n\n</custom-element>`,
  `<div><!--\n\n</div>\n\n${tag}\n\n-->`,
  `Before <span>\n\n${tag}\n\n</span>`,
  `<div>\n<script>\n\n</div>\n\n${tag}\n\n</script>\n</div>`,
  `Before <span>\n${tag}\n</span>`, `<!-- ${tag} -->`,
  `> ${tag}`, `- ${tag}`, `| File |\n| --- |\n| ${tag} |`,
  `$$\n${tag}\n$$`, '<artifact name="report.md"',
];
for (const text of forbidden) {
  assert.deepEqual(rendered(text).names, [], text);
  // Exercise every streaming prefix: raw-block context must never be lost at blank lines.
  for (let i = 1; i <= text.length; i++) {
    assert.deepEqual(rendered(text.slice(0, i), true).names, [], `streaming prefix ${i}: ${text}`);
  }
}

for (const text of [
  `<!--\n\n${tag}\n-->\n\n${tag}`,
  `~~~html\n\n${tag}\n~~~\n\n${tag}`,
  `    code\n\n    ${tag}\n\n${tag}`,
  `<div>\n${tag}\n</div>\n\n${tag}`,
]) assert.deepEqual(rendered(text).names, ['report.md'], text);

// An artifact at the start must not hide a later code/raw opener from CommonMark's parser.
for (const raw of [
  `<!--\n\n${tag}\n-->`, `<script>\n\n${tag}\n</script>`,
  `~~~html\n\n${tag}\n~~~`, `\`\`\`html\n\n${tag}\n\`\`\``,
]) {
  const text = `${tag}\n${raw}`;
  assert.deepEqual(rendered(text).names, ['report.md'], text);
  for (let i = 1; i <= text.length; i++) {
    assert.ok(rendered(text.slice(0, i), true).names.length <= 1, `raw after card prefix ${i}: ${text}`);
  }
}
assert.match(render(`[ref]: https://example.com\n${tag}\n[ref]`).html, /href="https:\/\/example.com"/);
assert.match(render(`${tag}\nOne\nTwo`).html, /One<br\/>\nTwo/);
const table = '| A | B |\n| - | - |\n| 1 | 2 |';
assert.match(rendered(`${tag}\n${table}`).html, /<table>/);
assert.match(rendered(`3. one\n\n4. two\n\n${tag}`).html, /<ol start="3">/);
const stable = splitArtifactMarkdown(`Intro\n\n${tag}\n\n`);
assert.deepEqual(stable.blocks, ['Intro', tag]);
for (const tail of ['A', '**growing', '```html\n\n' + tag, '<!--\n\n' + tag]) {
  const next = splitArtifactMarkdown(`Intro\n\n${tag}\n\n${tail}`);
  assert.deepEqual(next.blocks.slice(0, stable.blocks.length), stable.blocks);
}
assert.deepEqual(rendered(`${tag}\n\n<artifact name="incomplete`, true).names, ['report.md']);
assert.deepEqual(rendered(`${tag}\n`, true).names, []);
assert.deepEqual(splitArtifactMarkdown('Use `<div>` literally\n\n').blocks, ['Use `<div>` literally']);
assert.deepEqual(splitArtifactMarkdown('Use \\<div> literally\n\n').blocks, ['Use \\<div> literally']);
assert.equal(render(Array.from({ length: 300 }, () => tag).join('\n')).names.length, 300);
assert.match(render('<artifact name="&lt;script&gt;.md"/>').html, /^<div><\/div>$/);
console.log('Artifact tag parser, streaming context and Markdown semantics passed.');

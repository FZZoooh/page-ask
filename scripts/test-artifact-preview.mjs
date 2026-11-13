import assert from 'node:assert/strict';
import {
  artifactPreviewKind,
  artifactCodeLanguage,
  parseDelimitedPreview,
} from '../src/lib/artifact-preview.mjs';

let checks = 0;
function preview(text, headers, rows, truncated = false, delimiter = ',') {
  assert.deepEqual(parseDelimitedPreview(text, delimiter), { headers, rows, truncated });
  checks++;
}
function malformed(text, delimiter = ',') {
  assert.throws(() => parseDelimitedPreview(text, delimiter), SyntaxError, text.slice(0, 80));
  checks++;
}

for (const [kind, extensions] of [
  ['html', ['html', 'htm']],
  ['markdown', ['md', 'markdown']],
  ['table', ['csv', 'tsv']],
  ['code', ['js', 'txt', 'log', 'unknown']],
]) {
  for (const ext of extensions) {
    for (const name of [`report.${ext}`, `报告.notes.${ext.toUpperCase()}`]) {
      assert.equal(artifactPreviewKind(name), kind, name);
      checks++;
    }
  }
}
for (const [language, extensions] of [
  ['javascript', ['js', 'mjs', 'jsx']], ['typescript', ['ts', 'tsx']],
  ['python', ['py']], ['rust', ['rs']], ['go', ['go']], ['java', ['java']],
  ['cpp', ['c', 'cpp', 'h']], ['json', ['json']], ['css', ['css']], ['xml', ['xml']],
  ['sql', ['sql']], ['yaml', ['yml', 'yaml']], ['ini', ['ini', 'toml']], ['latex', ['tex']],
]) {
  for (const ext of extensions) {
    for (const name of [`report.${ext}`, `报告.notes.${ext.toUpperCase()}`]) {
      assert.equal(artifactCodeLanguage(name), language, name);
      checks++;
    }
  }
}
for (const name of ['', 'README', 'report.', 'report.txt', 'report.LOG', 'report.unknown', 'report.js.txt']) {
  assert.equal(artifactPreviewKind(name), 'code', name);
  assert.equal(artifactCodeLanguage(name), null, name);
  checks += 2;
}
for (const separator of ['/', '\\']) {
  assert.equal(artifactPreviewKind(`folder.html${separator}README`), 'code');
  assert.equal(artifactCodeLanguage(`folder.js${separator}README`), null);
  assert.equal(artifactPreviewKind(`folder.js${separator}report.HTM`), 'html');
  assert.equal(artifactCodeLanguage(`folder.html${separator}report.TSX`), 'typescript');
  checks += 4;
}

for (const text of ['', '\ufeff', '\n', '\r\n\n\r', '\ufeff\r\n\n']) preview(text, [], []);
preview('title', ['title'], []);
preview('\r\n\nname,age\r\nAda,36\r\nLin,40\n', ['name', 'age'], [['Ada', '36'], ['Lin', '40']]);
preview('name\n\nAlice\r\n\r\nBob\n', ['name'], [['Alice'], ['Bob']]);
preview('h\ra\rb\r', ['h'], [['a'], ['b']]);
preview('h\nlast', ['h'], [['last']]);
preview('h\nlast\n', ['h'], [['last']]);
preview(',,', ['', '', ''], []);
preview('""', [''], []);
preview('""\n""', [''], [['']]);
preview('a,b\n,', ['a', 'b'], [['', '']]);
preview('a,b,\nx,y,\n,,', ['a', 'b', ''], [['x', 'y', ''], ['', '', '']]);
preview('a,a,\nx\ny,z,w,q', ['a', 'a', '', ''], [['x', '', '', ''], ['y', 'z', 'w', 'q']]);
preview('wide,header,here\na,b\nc', ['wide', 'header', 'here'], [['a', 'b', ''], ['c', '', '']]);
preview(' \n  \n\t', [' '], [['  '], ['\t']]);
preview(' a , b \n x ," y "', [' a ', ' b '], [[' x ', ' y ']]);
preview('"first,name","say ""hello"""\n"a,b","""quoted"""',
  ['first,name', 'say "hello"'], [['a,b', '"quoted"']]);
preview('h\n""""\n""""""', ['h'], [['"'], ['""']]);
preview('"multi\nline",h\n"one\r\ntwo\nthree",end', ['multi\nline', 'h'], [['one\r\ntwo\nthree', 'end']]);
preview('\ufeff姓名,备注\r\n李雷,"你好，世界 🌍"\r\n"é é","雪\n❄️"',
  ['姓名', '备注'], [['李雷', '你好，世界 🌍'], ['é é', '雪\n❄️']]);
preview('\ufeffh\n\ufeffvalue', ['h'], [['\ufeffvalue']]);
preview('"\ufeffh"\nvalue', ['\ufeffh'], [['value']]);
preview('HTML,formula\n<script>alert(1)</script>,=1+1\n"<b>literal</b>","=SUM(A1,B1)"',
  ['HTML', 'formula'], [['<script>alert(1)</script>', '=1+1'], ['<b>literal</b>', '=SUM(A1,B1)']]);
preview('h\n\u0000literal', ['h'], [['\u0000literal']]);

preview('\ufeffname\tvalue\r\n"a\tb"\t"x,y"\n"line\nnext"\t"say ""hi"""',
  ['name', 'value'], [['a\tb', 'x,y'], ['line\nnext', 'say "hi"']], false, '\t');
preview('a,b\tsecond\nx,y\tend\t', ['a,b', 'second', ''], [['x,y', 'end', '']], false, '\t');
preview('\t\t\n1\t2', ['', '', ''], [['1', '2', '']], false, '\t');
preview('h\n\t', ['h', ''], [['', '']], false, '\t');

for (const text of [
  '"', '"unclosed', 'h\n"unclosed\ncell', '"a""', '"""',
  'a"b', 'a,"b"c', '"a" x', '"a" ', '"a"\t', '"a";b',
  'h\n"a""b', 'h\r\n"a"\r\nb"c',
]) malformed(text);
malformed('h\tother\n"a" b\tvalue', '\t');
malformed('h\tother\n"a",value', '\t');
for (const delimiter of ['', ';', '|', '::', '\n', null, 1]) {
  assert.throws(() => parseDelimitedPreview('h', delimiter), TypeError);
  checks++;
}
for (const text of [null, undefined, 1, {}, []]) {
  assert.throws(() => parseDelimitedPreview(text), TypeError);
  checks++;
}

const columns = Array.from({ length: 101 }, (_, i) => `c${i}`);
preview(columns.slice(0, 100).join(','), columns.slice(0, 100), []);
preview(columns.join(','), columns.slice(0, 100), [], true);
preview(`h\n${columns.join(',')}`, ['h', ...Array(99).fill('')], [columns.slice(0, 100)], true);
preview(`${columns.join(',')}\nvalue`, columns.slice(0, 100), [['value', ...Array(99).fill('')]], true);
// Discarded columns still participate in quote validation, never in cell allocation.
malformed(`${Array(100).fill('h').join(',')},"bad"text`);
malformed(`h\n${Array(100).fill('v').join(',')},"unclosed`);
preview(`h\n${Array(100).fill('v').join(',')},"extra,cell\nwith ""quotes"""`,
  ['h', ...Array(99).fill('')], [Array(100).fill('v')], true);

const dataRows = Array.from({ length: 500 }, (_, i) => [String(i)]);
const full = `h\n${dataRows.map((row) => row[0]).join('\n')}`;
preview(full, ['h'], dataRows);
preview(`${full}\n\n\r\n`, ['h'], dataRows);
preview(`${full}\nextra`, ['h'], dataRows, true);
preview(`${full}\nextra\n"invalid tail`, ['h'], dataRows, true);
preview(`${full}\n"extra\nrecord"\n"invalid tail`, ['h'], dataRows, true);
preview(`${full}\nextra,wider`, ['h', ''], dataRows.map((row) => [row[0], '']), true);
malformed(`${full}\n"invalid lookahead`);
malformed(`${full}\n"extra"bad`);
preview(`${full}\n${columns.join(',')}`, ['h', ...Array(99).fill('')],
  dataRows.map((row) => [row[0], ...Array(99).fill('')]), true);

const maxInput = 1024 * 1024;
const largeCell = 'x'.repeat(maxInput);
preview(largeCell, [largeCell], []);
const manyEscapes = '"'.repeat(maxInput);
preview(manyEscapes, ['"'.repeat((maxInput - 2) / 2)], []);
preview(','.repeat(maxInput), Array(100).fill(''), [], true);
preview('\n'.repeat(maxInput), [], []);
preview(`h\n${'x\n'.repeat((maxInput - 2) / 2)}`, ['h'], Array.from({ length: 500 }, () => ['x']), true);
assert.throws(() => parseDelimitedPreview('x'.repeat(maxInput + 1)), RangeError);
checks++;

console.log(`Artifact preview: ${checks} mapping, CSV/TSV, Unicode, strict syntax and bounded-allocation checks passed.`);

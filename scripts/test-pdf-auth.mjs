// Regression: when the backend is configured with a token, /pdf must reject requests without
// the matching Authorization header and accept the extension's bearer token. Run:
// node scripts/test-pdf-auth.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = mkdtempSync(join(tmpdir(), 'pageask-pdf-auth-home-'));
const data = mkdtempSync(join(tmpdir(), 'pageask-pdf-auth-data-'));
mkdirSync(join(home, '.config', 'righthandman'), { recursive: true });

const TOKEN = 'pdf-test-token';
const pdf = readFileSync(join(root, 'test', 'marker.pdf')).toString('base64');

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !extra ? '' : ` — ${extra}`}`);
  if (!ok) failures += 1;
};

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

const port = await freePort();
writeFileSync(
  join(home, '.config', 'righthandman', 'settings.json'),
  JSON.stringify({
    baseUrl: 'http://127.0.0.1:9',
    model: 'fake',
    apiKey: 'test-key',
    state: 'off',
    port,
    token: TOKEN,
    dataDir: data,
  }),
);

const child = spawn(process.execPath, [join(root, 'server', 'index.mjs')], {
  env: { ...process.env, USERPROFILE: home, HOME: home },
  stdio: 'ignore',
});

const base = `http://127.0.0.1:${port}`;
const waitUp = async () => {
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(`${base}/health/live`);
      if (r.ok) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

const postPdf = async (headers = {}, payload = { base64: pdf }) => {
  const res = await fetch(`${base}/pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* no JSON */
  }
  return { res, body };
};

try {
  check('后端启动', await waitUp());

  const noToken = await postPdf();
  check('无 token 的 /pdf 返回 401', noToken.res.status === 401, String(noToken.res.status));
  check('无 token 的错误码是 auth.bad_token', noToken.body?.code === 'auth.bad_token', JSON.stringify(noToken.body));

  const wrong = await postPdf({ Authorization: 'Bearer wrong-token' });
  check('错误 token 的 /pdf 返回 401', wrong.res.status === 401, String(wrong.res.status));

  const good = await postPdf({ Authorization: `Bearer ${TOKEN}` });
  check('正确 token 的 /pdf 返回 200', good.res.status === 200, `${good.res.status} ${JSON.stringify(good.body).slice(0, 200)}`);
  check('提取出至少一页', (good.body?.pageCount ?? 0) >= 1, JSON.stringify(good.body).slice(0, 200));
  check('提取出正文', typeof good.body?.text === 'string' && good.body.text.trim().length > 0, JSON.stringify(good.body).slice(0, 200));

  // Acceptance C1: local file URLs are not limited to the user profile / temp directory.
  const localPdf = join(root, 'test', 'marker.pdf');
  const local = await postPdf({ Authorization: `Bearer ${TOKEN}` }, { fileUrl: pathToFileURL(localPdf).href });
  check('本地 PDF 可以位于用户目录之外', local.res.status === 200, `${local.res.status} ${JSON.stringify(local.body).slice(0, 200)}`);
  check('本地 PDF 位于仓库测试目录', !localPdf.toLowerCase().startsWith(home.toLowerCase()), localPdf);
} finally {
  child.kill();
  await new Promise((r) => {
    if (child.exitCode !== null) return r();
    child.once('exit', r);
    setTimeout(r, 3000);
  });
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* Windows may hold the sqlite handle briefly; the temp dir is harmless */
  }
}

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exitCode = failures ? 1 : 0;

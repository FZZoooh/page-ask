# PageAsk 代码质量审查报告

- 审查日期：2026-11-09
- 审查对象：`HEAD de5d391e363836a59b37cff8ace47eb96cca6760`（`fix: clear remaining P3 review findings`，2026-11-08 22:59:49 +0800）
- 审查范围：`src/`、`server/`、`scripts/`、`wxt.config.ts`、`package.json`、`.github/workflows/ci.yml`、i18n 字典与测试脚本
- 审查方式：逐文件阅读 + `pnpm verify` 基线 + 三个只读独立审计（前端、后端安全、工具链/CI）交叉验证
- 代码改动：**无**。本报告只记录问题与建议，没有修改任何产品代码

## 1. 结论

产品运行路径（扩展 + 后端）**没有发现 P1 级问题**。安全基线整体扎实：后端只监听 `127.0.0.1`；Host 白名单先于路由；CORS 对未知 Origin 失败关闭；设置页无 `innerHTML`/`eval`；SQL 全部参数化；API Key 不出现在扩展、日志、`/health` 或公开设置里；SSRF 防护覆盖数字型 IPv4、IPv6 映射、DNS 多记录和每一跳重定向。

本次发现：

| 级别 | 数量 | 说明 |
| --- | --- | --- |
| P1 | 1 | 仅开发脚本 `scripts/edge-test.ps1`：`-ProfileName` 可让递归删除越出仓库，属于本地数据丢失风险，不在产品/CI 运行路径 |
| P2 | 8 | 5 个产品缺陷 + 3 个工程/测试缺陷 |
| P3 | 24 组 | 协议漂移、边界校验、错误处理、可访问性、测试卫生等 |

最值得先修的五项：

1. `replace` SSE 事件被前端当作增量追加，最终答案会在气泡里重复一遍（`App.tsx:617-621` 与 `App.tsx:542-553`）。
2. 带 `utm_*` 等追踪参数的页面，截图能力会静默失效（`App.tsx:577` 与 `extract.ts:417-426`）。
3. `read_page scope="viewport"` 使用的是打开面板时的旧视口快照，用户滚动后答案会答错（`tools.mjs:158-177`）。
4. PDF 解析不受 60 秒工具超时和 Stop 约束，且 `readPdfTab` 没有 fetch 超时，可能让面板无限转圈（`tools.mjs:327-350`、`pdf.ts:128-162`）。
5. 上游非 2xx 响应体被无上限读入，错误消息还可能整段进 SSE 与日志（`index.mjs:1123`、`index.mjs:1339-1343`）。

## 2. 基线验证

在审查开始时执行了完整验证，结果全部通过：

```
pnpm verify
  check:i18n       通过
  compile          tsc --noEmit + 60 个 .mjs / 6 个 PowerShell 语法与 BOM 检查，通过
  test:server      25 个后端回归全部通过
  build            wxt build 成功，总产物 2.18 MB
```

唯一的构建警告是既有的 `sidepanel` chunk 约 1.03 MB，超过 500 KB 提示阈值；这不是本次改动引入的回归，但说明主面板代码体积已经偏大（见 §5.1）。

25 个回归覆盖了：extension-id、upstream URL、turn integrity、reasoning replay、turn abort、empty stream、incomplete/bad body、lifecycle recover、settings webui、SSRF、PDF auth、partial failure、auto title、truncated stream、chat busy、stateful fallback、host、tool cap、page metadata、i18n chat、SSE CRLF、PDF limits、history page、hist time、markdown stream。

另外，后端安全审计在一个临时实例（临时 `USERPROFILE`、临时数据库、带 token）上做了 20 个请求级探针；工具链审计只运行了 `check-i18n`，没有触碰真实配置。所有关键结论都在本报告中按源码行号复核过。

## 3. P1

### P1-1 `edge-test.ps1` 的 `-ProfileName` 可以递归删除仓库之外的目录

**位置**：`scripts/edge-test.ps1:13`、`:25-33`

```powershell
[string]$ProfileName = '',
...
if (-not $ProfileName) { $ProfileName = ".edge-profile$DebugPort" }
$profileDir = Join-Path $root $ProfileName
...
Remove-Item -Recurse -Force $profileDir
```

`ProfileName` 没有任何字符或路径约束，`Join-Path` 也不会把 `..` 限制在 `$root` 内。以下调用都会命中删除分支（只要不加 `-Reuse`）：

- `-ProfileName ..`：`$profileDir` 解析为仓库父目录，递归删除父目录内容；
- `-ProfileName .`：解析为仓库根目录，删除整个仓库（含 `.git`）；
- `-ProfileName .output`：删除构建产物；
- `-ProfileName Default`：还会用 `CommandLine -like "*Default*"` 杀掉正常的 Edge 进程。

默认参数（`.edge-profile<port>`）是安全的，因此这不是日常路径；但这是一个**显式参数即可触发的数据丢失**，而且脚本没有二次确认。它不在产品运行路径和 CI 中，所以定为“P1（开发工具）”，不是产品 P1。

**建议**：

- 只接受 `^[A-Za-z0-9._-]+$`，并拒绝 `.`、`..`、空串；
- profile 统一放到 `Join-Path $root '.edge-profiles'` 下，删除前用 `[IO.Path]::GetFullPath()` 校验结果以 `$root + [IO.Path]::DirectorySeparatorChar` 开头；
- 只删除带标记文件（例如 `.pageask-edge-profile`）的目录；
- 杀进程时匹配完整的 `--user-data-dir=<profileDir>`，不要用模糊的 `-like "*$ProfileName*"`。

## 4. P2

### P2-1 `replace` 事件被追加而不是替换，最终答案重复

**位置**：`src/entrypoints/sidepanel/App.tsx:542-553`、`:617-621`；`server/index.mjs:1224-1227`

服务端在最终文本与已流式文本不一致时会发：

```js
emit('replace', { text: finalText });
```

前端收到后：

```js
} else if (ev.type === 'replace') {
  ensureTarget();
  contentBuf = ev.text;
  schedule();
}
```

但 `flush()` 的实现是：

```js
setMessages(prev => prev.map(m =>
  m.id === id ? { ...m, content: m.content + c, reasoning: ... } : m
));
```

也就是说，`replace` 只是把**待发送缓冲区**换成了完整最终文本，已经 flush 到气泡里的旧前缀仍然保留，下一次 flush 会把完整最终文本再追加一次。结果是：

- 气泡里出现“流式前缀 + 完整最终文本”的重复内容；
- 数据库里只有 `finalText`，所以刷新页面后又恢复正常，形成“界面与 DB 分叉”；
- 如果 `replace` 到达时还有待 flush 的旧 delta，那些 delta 会被覆盖，但已显示的前缀仍会重复。

这个问题在正常回答与最终文本一致时不会触发，因此现有 25 个后端回归（只校验 SSE 帧和 DB）发现不了；它属于前端事件处理缺陷。

**建议**：`replace` 分支不要走 `contentBuf` 追加路径，而是把该气泡的 `content` 直接设为 `ev.text`，清空 `contentBuf`，并同步处理待 flush 的 reasoning；如果希望保留“先流式后校正”的动画，可以先 `flush()` 再 `setMessages` 覆盖。最好把这段事件归约逻辑抽成纯函数并加一个前端单测。

### P2-2 带追踪参数的 URL 会让截图静默失效

**位置**：`src/entrypoints/sidepanel/App.tsx:196-199`、`:577`；`src/lib/extract.ts:417-426`；`src/lib/settings.ts:91-101`

`load()` 会把页面 URL 规范化后再放进 `page`：

```js
setPageState({ kind: 'ready', page: { ...result.page, url: normalizeUrl(result.page.url) } });
```

`normalizeUrl()` 会删除 `utm_*`、`fbclid`、`gclid`、`spm`、`ref` 和 hash。发送时：

```js
const [shot, sel] = await Promise.all([captureScreenshot(page.url), readSelection()]);
```

`captureScreenshot()` 的校验却只去掉 hash：

```js
const stripHash = (url) => url.split('#')[0];
if (expectedUrl && stripHash(tab?.url) !== stripHash(expectedUrl)) return null;
```

只要原 URL 带 `?utm_source=...` 之类的参数，`page.url` 已被去掉参数，而 `tab.url` 仍带着参数，比较必然失败，截图返回 `null`。用户不会看到错误，只会发现模型“看不到截图”。这不是罕见场景：从微信、邮件、搜索引擎复制出来的链接经常带追踪参数。

**建议**：把两边都做同一种规范化（例如 `captureScreenshot(normalizeUrl(tab.url), normalizeUrl(page.url))`），或者让 `captureScreenshot` 接收“原始 tab URL + 规范化后的 page URL”并只比较规范化结果。更稳妥的做法是把 URL 比较抽成 `sameDocumentUrl(a, b)`，同时处理 hash、追踪参数和末尾斜杠。

### P2-3 `read_page scope="viewport"` 使用打开面板时的旧视口

**位置**：`App.tsx:191-199`、`:580-590`；`server/tools.mjs:158-177`

页面加载时 `grabPage()` 抓取的 `viewport` 会随 `page` 一起保存；发送时只刷新了 `selection` 和截图：

```js
page: {
  ...page,
  selection: selected,
  selectionContext: sel,
  screenshot: shot,
},
```

`page.viewport` 仍是打开面板时的快照。用户向下滚动后问“当前屏幕里是什么”，模型调用 `read_page scope="viewport"`，拿到的是旧位置、旧文本，却会被提示为“当前可见区域”。这是一个**语义正确性**问题，不是性能问题。

**建议**：

- 发送前重新注入一个轻量的视口读取函数，刷新 `viewport`；
- 或者取消 `scope="viewport"` 的“实时”承诺，在工具结果里注明快照时间，并让模型优先用 `screenshot`；
- 如果重新抓视口成本太高，至少把旧的 `scrollY`/`height` 与当前页面状态一起传给模型，让它知道数据可能过期。

### P2-4 PDF 解析不受工具超时/Stop 约束，PDF 读取也没有 fetch 超时

**位置**：`server/tools.mjs:327-350`；`server/pdf.mjs:63-105`；`src/lib/pdf.ts:128-162`；`server/index.mjs:886-923`

`fetchPdf()` 的 30 秒 `AbortSignal` 只覆盖下载阶段：

```js
const timeout = AbortSignal.timeout(30_000);
const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
const res = await fetchPublic(url, { ..., signal: stop });
...
const out = await extractPdfText(buf);
```

`extractPdfText()` 没有接收 signal。工具循环虽然创建了 `AbortSignal.timeout(TOOL_TIMEOUT)`，但只是把它传给 `runTool()`，随后直接 `await runTool(...)`；没有 `Promise.race`，也没有办法中断 pdfjs 的 CPU 解析。因此：

- 一个 400 页、文本层复杂的 PDF 可以远超 60 秒；
- 用户点 Stop 只会让控制器 abort，解析仍继续占用 CPU，直到 pdfjs 自己结束；
- 期间该对话的 `activeChats` 一直占用，删除会话返回 409，用户只能等；
- 前端 `readPdfTab` 对 PDF URL 的 `fetch` 和向后端 `/pdf` 的 `fetch` 都没有超时，服务器不响应时面板会一直停在 loading。

**建议**：

- `extractPdfText` 接收 `signal`，在每页开始和 `getTextContent()` 前后检查 `signal.aborted`，并在 abort 时调用 pdfjs 的 `loadingTask.destroy()` / `page.cleanup()`；
- 工具循环用 `Promise.race([runTool(...), abortPromise])` 保证即使底层不配合，也能在 60 秒后释放本轮；
- `readPdfTab` 的两次 fetch 加 `AbortSignal.timeout(30_000)`，失败时给本地化错误；
- 这是“可靠性/可取消性”修复，不需要改 PDF 解析算法。

### P2-5 上游非 2xx 响应体无上限读入，错误消息可能整段进 SSE/日志

**位置**：`server/index.mjs:1123`、`:1318-1343`

```js
if (!upstream.ok || !upstream.body) {
  const detail = await upstream.text();
  throw new UpstreamError(upstream.status, detail);
}
```

`upstream.text()` 没有长度上限。一个配置错误、代理返回 HTML 错误页、或恶意上游可以返回几百 MB，进程会先整体读进内存再构造错误。随后 `UpstreamError.friendly()`：

```js
upstreamMsg = JSON.parse(this.detail)?.error?.message ?? '';
```

从 JSON 里取出的 `error.message` 也没有 `slice`，会原样拼进 SSE `error` 的 `message`，再被前端放进气泡、被 `logError` 写进日志。`UpstreamError` 构造函数虽然只把 `detail.slice(0, 500)` 放进 `Error.message`，但 `this.detail` 仍保留完整字符串。

**建议**：

- 用 `readBodyCapped(upstream, 64 * 1024)` 读取错误体，失败时退回状态码文本；
- `friendly()` 对从 JSON 取出的 `upstreamMsg` 做 `String(...).slice(0, 300)`；
- `this.detail` 也做硬上限（例如 8 KB），日志只记截断后的内容；
- 同理处理 `server/tools.mjs:406` 和 `/api/settings/test` 的 `r.text()`。

### P2-6 `probe-responses.mjs` 未加真实配置门禁，会消耗真实 API Key

**位置**：`scripts/probe-responses.mjs:4-23`

```js
const cfg = readSettings();
const KEY = cfg.apiKey;
const BASE = cfg.baseUrl.replace(/\/+$/, '');
...
fetch(`${BASE}/responses`, { headers: { Authorization: `Bearer ${KEY}` }, ... });
```

该脚本直接读取真实 `~/.config/pageask/settings.json`，没有 `PAGEASK_ALLOW_REAL=1` 检查，也没有 `withV1()`。11-08 的审查已经把 `test-chat`、`test-cache`、`test-shot`、`test-pdf-prompt`、`test-selection-context` 和 `probe-sw` 纳入门禁，但 `probe-responses.mjs` 被漏掉了。运行一次就会对真实账号发起可能计费的 `/responses` 请求；在 baseUrl 带 `/v1` 时还会打错路径。

**建议**：复用 `scripts/require-real-config.mjs`，在读取 key 之前要求 `PAGEASK_ALLOW_REAL=1`；URL 改用 `withV1(cfg.baseUrl)`；在文件头注释中写明会计费。

### P2-7 后端回归没有单项超时，整条 `&&` 链在 CI 里可能静默挂死

**位置**：`package.json:23-24`；`.github/workflows/ci.yml:20`

`test:server` 是 25 个 `node ... && node ...` 串联，只有 `test-turn-abort` 自己传了 `AbortSignal`。如果某个脚本里的 `fetch`/子进程/临时服务器卡住，CI 只会在 20 分钟后被 job timeout 终止，日志里看不出是哪一个脚本。本地 `pnpm verify` 也会一直停住。

**建议**：

- 给每个测试脚本加统一的 `timeout` 包装（Node 22 可用 `AbortSignal.timeout` 或 `node:test` 的 timeout）；
- CI 拆成 matrix 或至少在每个脚本前后打印 `▶/✓` 标记，让超时能定位；
- 所有测试内的 `fetch` 都显式带超时，禁止裸 `fetch`。

### P2-8 `check-i18n` 看不到 JSX 文本节点，且 glob 依赖当前工作目录

**位置**：`scripts/check-i18n.mjs:139-166`

`collectJsStrings()` 只收集带引号的字符串字面量（含模板字符串），不扫描 JSX 文本节点。因此：

```tsx
<div>确定</div>
```

会完全绕过守卫。当前代码没有这种写法，但守卫的职责就是防止未来出现；这类文本恰恰是最容易被写死的 UI 文案。

另外，`globSync('src/**/*.{ts,tsx}')` 和 `globSync('server/**/*.mjs')` 都是相对 `process.cwd()` 的。从 `docs/` 或任何子目录运行 `node ../scripts/check-i18n.mjs` 时，匹配结果为空，脚本仍然打印成功。

**建议**：

- 用 TypeScript 编译器 API 或一个最小的 JSX 文本扫描器，把 `JsxText` 和 `JSXExpressionContainer` 中的字符串也纳入；
- glob 以 `dirname(dirname(fileURLToPath(import.meta.url)))` 为根，或在开头 `process.chdir(root)`；
- 匹配文件数为 0 时直接失败，而不是成功。

## 5. P3

以下按主题合并；每行都给出位置和可执行的修复方向。它们不影响主流程可用性，但会在特定场景造成错误、误导或维护成本。

### 5.1 前端/协议

| ID | 位置 | 问题与建议 |
| --- | --- | --- |
| F-1 | `src/lib/chat.ts:40-104`；`server/index.mjs:699`、`:845-852` | 协议类型漂移：`meta` 声明 `messageId`，服务端发 `userMessageId`；`done.message.ms` 在客户端是必填，服务端从不发送；SSE 帧没有运行时校验。建议以服务端为准修正类型，或让服务端补齐字段；对 `JSON.parse` 结果做最小形状校验。 |
| F-2 | `App.tsx:670-684` | `done` 把 `ev.totals.tokensIn/Out` 写进每条答案的气泡，显示的是整个会话累计值，不是本轮值；服务端 `done.message` 没有携带 per-turn token。建议在 `done.message` 补 `tokensIn/Out/ms`，前端优先使用。 |
| F-3 | `App.tsx:175-187` | `refreshConversations` 捕获所有错误后 `setConversations([])`，后端不可用时历史列表看起来像“没有历史”，且不设置 `loadError`。建议保留旧列表并显示错误条。 |
| F-4 | `App.tsx:191-198`、`:273-346` | 每次 `load()` 先把 `pageState` 设为 loading，`pageUrl` 变成 null 再恢复；tab-change effect 会重新执行并自动恢复 `list[0]`。用户点“新对话”后，只要页面再触发一次 complete 更新，就可能被旧会话覆盖。建议区分“页面重载”和“用户主动新对话”，或把 `conversationId` 持久化到会话状态。 |
| F-5 | `App.tsx:577`；`extract.ts:271-329` | `readSelection()` 没有 expected URL 校验；发送瞬间切标签，截图会返回 null，但选区可能来自新标签，形成“旧正文 + 新选区”。建议给 `readSelection` 增加 expectedUrl，或在 `send` 里先固定 tab id/URL 再并行读取。 |
| F-6 | `App.tsx:777-790`；`server/index.mjs:677` | 首次发送在 `meta` 到达前失败时，`conversationId` 仍为 null；用户点重生成会创建新会话，服务端 `truncateAfterLastUser` 返回 null，最终以空历史请求。建议无会话时禁用重生成，或退回普通发送。 |
| F-7 | `background.ts:24`、`:33-37` | 右键菜单标题只在 service worker 启动/安装时用 `t()` 生成，而 service worker 从未 `setLocale()`，实际始终是 zh-CN；切换语言后也不会更新。建议读取 `chrome.storage` 设置、`setLocale(resolveLocale(...))`，并在 `storage.onChanged` 时 `contextMenus.update`。 |
| F-8 | `App.tsx:1203`、`:392-406`；`style.css:861-863`、`:876` | 可访问性：`aria-live` 只在流结束后才加上，屏幕阅读器不会播报流式内容；引用按钮只监听 mouseup，键盘选择无法引用；输入框 `outline: none` 只靠 1px 边框变色；11px 元数据对比度偏低；`contenteditable` 没有 `onDrop` 防护，拖入 HTML/图片会进入编辑器。建议补 keyup/selectionchange、`aria-busy`、`:focus-visible`、`onDrop` 纯文本化和对比度。 |
| F-9 | `index.html:2`；`PageCard.tsx:38-39`；`App.tsx:1188`；`pdf.ts:120,158` | 细节一致性：`<html lang="zh-CN">` 硬编码，加载设置后才同步；`toLocaleString()` 未传 locale；PDF 错误用中文全角括号包裹本地化文本，英文界面会出现 `Cannot reach backend（fetch failed）`。建议统一由 locale 驱动。 |
| F-10 | `App.tsx:191-199`、`:580-590` | 页面正文也只在 `load()` 时抓取；SPA 内容更新或无限滚动后，`read_page` 仍返回旧正文。视口问题已单列为 P2-3；正文快照至少应在工具结果里注明“读取于面板打开时”，或提供刷新入口。 |
| F-11 | `src/lib/chat.ts:141-150` | `httpJson` 对 GET 也设置 `Content-Type: application/json`，每个历史/健康请求都多一次 CORS 预检。建议只在有 body 时设置。 |
| F-12 | `src/lib/settings.ts:65-76`；`pdf.ts:110,148`；`SettingsPanel.tsx` | `baseUrl()` 会去掉 query/hash，但 `pdf.ts` 用原始 `backendUrl` 拼 `/pdf`；`SettingsPanel.parseBackendUrl` 又允许 query/hash/credentials。用户填入 `http://host/?x=1` 时聊天正常、PDF 失败。建议所有端点统一走 `baseUrl()`，并在设置面板拒绝 query/hash/credentials。 |
| F-13 | `src/lib/pdf.ts:42-45` | `readCappedBody` 在 `res.body` 不存在时回退 `res.arrayBuffer()`，与后端“先限额再读”的规则不一致。建议无 body 时也按 `content-length` 拒绝或使用 `Response.clone().body` 的可用流。 |
| F-14 | `extract.ts:223-225` | 仅凭标题以 `.pdf` 结尾就把页面当 PDF；标题为 `report.pdf` 的 HTML 页面会走 PDF 路径并报“不是 PDF”。建议只按 URL/Content-Type 判定，标题最多作为弱提示。 |
| F-15 | `App.tsx:1188`、`HistoryPanel.tsx`、`PageCard.tsx` | 多处 `toLocaleString()` 不传 locale，数字分组跟随浏览器而不是 UI 语言；影响很小，但属于 i18n 收尾项。 |

### 5.2 后端/安全加固

| ID | 位置 | 问题与建议 |
| --- | --- | --- |
| B-1 | `server/index.mjs:305-347` | `/api/settings/test` 只凭 `Origin`/`Sec-Fetch-Site`/`Referer` 判同源；请求体可指定任意 `baseUrl`，未提供 draft key 时会回退到已保存的真实 Key 并发起请求。本机代理/同源页面可把 Key 送到指定主机；没有发现跨站浏览器路径，属于“困惑代理”加固项。建议 baseUrl 变更时要求显式重新输入 key，或在 UI 上显示目标主机并二次确认；`r.text()` 加 64KB 上限。 |
| B-2 | `server/index.mjs:498-500` | `/pdf` 对非本地路径错误返回 502，并把 `String(err.message)` 回给客户端；pdfjs 错误可能包含内部路径/堆栈片段。建议统一映射为 `pdf.failed`，细节只进日志。 |
| B-3 | `server/index.mjs:355-375` | `/health` 返回绝对 `settingsFile` 和 `db` 路径（含用户名），任何 token 持有者或同源请求都能读到。建议只返回 basename/是否可写，或把路径放到仅本地调试接口。 |
| B-4 | `server/index.mjs:1586-1624`、`:1466-1499`、`:692-696` | `readJson` 没有总超时/空闲超时，超限后仍继续 drain；`parseSseEvents` 的 `buffer` 没有上限；`res.write` 忽略 backpressure。三者都是本地/上游 DoS 面，建议分别加 `req.setTimeout`、SSE 行/缓冲区上限、`res.write` 返回值/`drain` 处理。 |
| B-5 | `server/index.mjs:1540-1542`；`server/settings.mjs:197-199`；`server/log.mjs:21`；`server/pdf.mjs:83-90`；`server/index.mjs:1265-1295` | 加固批次：token 用 `timingSafeEqual`；`writeSettings` 的固定 `.tmp` 改 `mkdtemp`/带 pid+随机后缀；日志同步 append 且无轮转；pdf 页 `cleanup()` 未放在 `finally`；截图文件只按“是否被引用”清理，被引用的会永久增长。建议按成本逐个处理，至少给日志和截图目录加容量上限。 |
| B-6 | `server/extension-id.mjs:42-50`、`:57-64` | `readExtensionKey` 把 ENOENT、JSON 解析失败、字段缺失都吞成 `''`，`resolveExtensionId` 因此把“损坏的 JSON”报成 `source:'missing'`，只有 base64/DER 校验失败才是 `invalid`。建议区分“文件不存在”和“文件存在但解析失败”，后者返回 `invalid` 并记录日志。 |
| B-7 | `server/errors.mjs:48`；`docs`/`AGENTS.md` | `errorPayload` 的兜底字段是 `error`，而文档多处写“`message` 作为 fallback”。前端两者都处理，测试只断言 `code`，所以没有功能问题，但契约文档与实现不一致。建议统一文档或同时输出 `message`。 |
| B-8 | `server/index.mjs:1383` | `page.pages` 未做类型/长度校验，直接插入系统提示的 PDF 行。该字段由本扩展生成，不是网页可控，因此不是注入漏洞；但服务端应把 `page.kind/pages` 当作不可信输入做形状校验，避免脚本/异常客户端传入长字符串。 |

### 5.3 工具链/测试/CI

| ID | 位置 | 问题与建议 |
| --- | --- | --- |
| T-1 | `scripts/start-server.ps1:10-11` | 最后一行 `node server/index.mjs` 后没有 `exit $LASTEXITCODE`，`pnpm server:win` 在启动崩溃时仍可能返回 0。建议显式传递退出码。 |
| T-2 | `scripts/tray-bg.ps1:61` | `Start-Process -ArgumentList $argv` 对数组按空格拼接，仓库路径含空格时 `-File $trayScript` 会被拆开，托盘后台启动失败。建议对每个参数加引号并转义内部双引号。 |
| T-3 | `scripts/tray.ps1:278`、`:318-333` | 自启动快捷方式名来自本地化字典；切换 UI 语言后再安装会生成新名字，旧 `.lnk` 不会被删除。建议使用固定文件名，或安装/删除时同时清理所有已知语言的名字。 |
| T-4 | `scripts/edge-test.ps1:61-71` | CDP 起来了但没找到扩展 service worker 时只 `Write-Warning`，脚本仍以 0 退出，CI/人工容易误判“扩展加载成功”。建议 `exit 1`；同时把脚本内的中文提示改为英文（AGENTS §5 要求脚本无用户可见中文，当前 check-i18n 只扫两个托盘脚本）。 |
| T-5 | `scripts/check-syntax.mjs:9`、`:45`；`src/lib/format-time.mjs`、`src/lib/markdown-stream.mjs` | 只检查 `server/` 和 `scripts/`；`src/lib/*.mjs` 既不被 `tsc` 的 `checkJs` 检查，也不被 `node --check` 检查。PowerShell 语法解析只在 win32 执行。建议把 `src/lib/*.mjs` 纳入 `node --check`，并在非 Windows 至少保留 BOM 检查。 |
| T-6 | `scripts/cdp-eval.mjs`、`cdp-key.mjs`、`cdp-dark.mjs` | `send()` 没有超时、失败也不 reject，CDP 卡住时脚本会永久等待；三份实现复制粘贴。建议抽一个带 `Promise.race(timeout)` 的公共模块。 |
| T-7 | `scripts/test-lifecycle-recover.mjs`、`test-turn-integrity.mjs`、`test-sse-crlf.mjs` | 测试卫生：lifecycle 清理只在 happy path；turn-integrity 不 `closeDb()`；sse-crlf 的 `rmSync` 未捕获 EBUSY；abort 测试用固定 400ms sleep 和中文文案断言，容易 flaky。建议统一 `try/finally` 清理、轮询持久化状态、只断言错误码。 |
| T-8 | `scripts/test-lifecycle-recover.mjs`、`test-extension-id.mjs` | 覆盖缺口：没有 schema 迁移测试（`PRAGMA table_info` + `ALTER TABLE` 只在旧库上跑）；没有“外站 Origin 403 / 扩展 Origin 放行”的 CORS 测试；extension-id 没有损坏 JSON 的 `invalid` 用例。建议各补 1-2 个回归。 |
| T-9 | `scripts/test-auto-title.mjs` 等 | 先用 `listen(0)` 取空闲端口、关闭后再让子进程监听，存在 TOCTOU；并发 CI 上偶发 EADDRINUSE。建议由子进程把实际端口写回文件/标准输出，父进程等待。 |
| T-10 | `package.json:19` | `check:server` 与 `compile` 的后半段完全重复，且没有任何脚本/文档引用。建议删除或改为独立用途。 |
| T-11 | `AGENTS.md:23`、`:94`；`scripts/check-syntax.mjs:67` | 文档漂移：AGENTS 说 PowerShell 语法检查是 `pnpm compile` 的一部分，但实际仅 win32 且只检查 `server/`+`scripts/`；`check-syntax.mjs` 自己还有中文诊断；`check-i18n` 只扫两个托盘脚本。建议同步文档，或把脚本诊断改为英文并纳入扫描。 |

## 6. 做得好的地方

- **安全基线**：只绑 `127.0.0.1`；Host 精确白名单先于路由；CORS 对未知 Origin 默认拒绝；扩展 ID 从 `extension-key.json` 派生，缺失时白名单为空而不是放行；设置页 CSP `frame-ancestors 'none'`；所有动态文本用 `textContent`。
- **SSRF**：`assertPublicHttpUrl` 覆盖非规范 IPv4（`127.1`、十进制、八进制、十六进制）、IPv4-mapped IPv6、NAT64、6to4、链路本地/ULA/文档地址；DNS 取全部记录，任一私网即拒绝；`fetchPublic` 手动跟随重定向并逐跳复验；`readBodyCapped` 先看 `content-length` 再流式计数。
- **数据边界**：`/chat` 4 MB、`/pdf` 64 MB、PDF 400 页/40 万字符、`MAX_OUTPUT_TOKENS=8192`、工具结果 `RESULT_CAP=8000`、截图 5 MB；关键路径都有硬上限，且 `untrusted_content` 会转义闭合标签。
- **状态机**：`sendingRef` 同步闸门、`runSeqRef` 丢弃过期流、50ms 批量 flush、工具调用后的 `ensureTarget`、停止/部分持久化/恢复、历史分页与截图回放预算，都是踩过坑之后的正确写法。
- **数据层**：SQL 全部参数化；`addTurn` 单事务；`truncateAfterLastUser` 的 boundary 与 DELETE 在同一 `BEGIN IMMEDIATE`；WAL + `busy_timeout`；分页按 rowid 而不是会碰撞的 `created_at`。
- **错误契约与 i18n**：错误码 `domain.reason` + `params` 贯穿前后端；服务端与扩展字典 key 对齐；`tError` 有 fallback；25 个回归只断言 `code`，不依赖中文句子。
- **测试/CI**：25 个后端回归覆盖了并发、截断、空流、CRLF、生命周期、SSRF、PDF 限制、历史分页等大量边界；CI 在 windows-latest + Node 22.13 上跑完整 `pnpm verify`。

## 7. 已接受/已记录的风险（本次不重复报告）

以下问题在 2026-11-07/11-08 的报告中已经讨论并接受，或属于明确的产品取舍；本次确认仍然存在，但不作为新发现：

- **DNS rebinding TOCTOU**：`assertPublicHttpUrl` 的 DNS 解析与 undici 实际连接之间仍有理论窗口；`server/net.mjs:1-8` 有说明，11-08 报告已接受。
- **工具循环没有步数上限**：AGENTS §4 明确“没有 step limit”；被提示注入的页面可以驱动多次 ≤300 秒的上游调用，只有 Stop 能终止。这是成本/可用性取舍，不是实现遗漏。
- **完整历史回放没有 token 预算**：长会话最终会被上游 400；面板分页只影响渲染，不影响回放。11-08 已列为 residual。
- **本地优先威胁模型**：token 可空；同用户的本机进程本来就能读 `settings.json`；`/api/settings*` 的“同源”只防浏览器跨站，不防本机代理。
- **`host_permissions: ['<all_urls>']`**：个人使用、不发布，`wxt.config.ts` 有注释说明。
- **PDF 内存缓存**：URL → 解析结果，10 分钟、最多 12 条；单进程、低并发，属于性能取舍。
- **`readLocalPdf` 允许任意可读的本地 `.pdf`**：2026-11-09 验收后按要求放宽（原限制为 `$HOME`/`%TEMP%`）。`/pdf` 仍受 token 保护，且只接受真实普通 `.pdf` 文件（拒绝 UNC/设备路径、限制 64 MB）；代价是 token 持有者/同源页面可让后端读取本机任意可读 PDF。这是“本地 PDF 读取”功能本身的边界。

## 8. 建议的修复顺序

1. **P1-1**：先修 `edge-test.ps1` 的路径约束；这是唯一可能造成不可逆数据丢失的问题。
2. **P2-1 / P2-2**：两个前端缺陷，改动小、用户可见，适合一起修并加回归。
3. **P2-3 / P2-4**：视口刷新与 PDF 可取消性；前者影响答案正确性，后者影响“Stop 是否真的停”。
4. **P2-5**：上游错误体限流；顺手把 `tools.mjs` 和 `/api/settings/test` 的同类 `text()` 一起处理。
5. **P2-6 / P2-7 / P2-8**：工程侧门禁与测试超时；这三项能防止后续回归再次漏掉。
6. **P3**：按 §5 分批；优先 F-1/F-2/F-3/F-7、B-4/B-5、T-1/T-2/T-4，其余可以随功能迭代处理。

不建议在修 P1/P2 之前做大规模重构。`server/index.mjs`（1624 行）和 `App.tsx`（1295 行）确实偏大，但当前拆分收益低于回归风险；可以先把 SSE 事件归约、工具循环、设置校验抽成可测试的纯函数，再考虑文件拆分。

## 9. 验证记录

- `git status --short`：审查开始时为空；本报告写入后仅新增 `docs/code-review-2026-11-09.md`。
- `pnpm verify`：退出码 0；i18n 守卫、`tsc --noEmit`、60 个 `.mjs` / 6 个 PowerShell 语法与 BOM、25 个后端回归、`wxt build` 全部通过。
- 构建：`sidepanel` chunk 约 1.03 MB（>500 KB 警告），总产物 2.18 MB。
- 后端安全审计：临时 `USERPROFILE` + 临时数据库 + token，20 个探针；未触碰真实配置。
- 工具链审计：只运行 `check-i18n`；其余为静态阅读与脚本代码复核。
- 本次没有修改任何 `src/`、`server/`、`scripts/` 或配置文件。

## 10. 修复落地（2026-11-09）

P1-1 与 P2-1…P2-8 已按本报告实现，P3 未动。主要落点：

- **P1-1**：`scripts/edge-test.ps1` 的 profile 名限制为单段合法字符，统一放到 `.edge-profiles/`，`GetFullPath` 后二次校验前缀，只删除带 `.pageask-edge-profile` 标记的目录，并按精确 `--user-data-dir` 结束进程；新增 `-ValidateOnly` 与回归 `test-edge-profile.mjs`。
- **P2-1**：`App.tsx` 的 `replace` 分支直接写入最终文本并清空 50ms 缓冲，不再走 `flush()` 的追加路径。
- **P2-2 / P2-3**：新增 `sameDocumentUrl()`，截图/选区/视口 URL 比较统一走 `normalizeUrl`；发送时重新读取当前视口（PDF 跳过），选区也带期望 URL 校验。
- **P2-4**：`extractPdfText()` 接受 `AbortSignal`，逐页检查并在 `finally` 里 `cleanup()`；工具循环用 `Promise.race` 让 Stop/60s 超时立即释放轮次；前端 PDF 下载 30s、`/pdf` 120s 超时，并新增 `page.failure.pdfTimeout`。
- **P2-5**：新增 `readErrorDetail()`，上游非 2xx 与 `/api/settings/test` 的错误体最多读 64 KB；`UpstreamError.detail` 截到 8 KB，`friendly()` 的 JSON message 截到 300 字；`tools.mjs` 的 `fetchJson` 同样限流。
- **P2-6**：`probe-responses.mjs` 先调用 `requireRealConfig()`，并通过 `withV1()` 拼 endpoint。
- **P2-7**：新增 `scripts/run-server-tests.mjs`，逐脚本执行、每项 180s 超时、Windows 用 `taskkill /T` 清理进程树；`test:server` 改走该 runner。
- **P2-8**：`check-i18n.mjs` 不再依赖 TS 编译器 API，改为注释/字符串剥离 + JSX 文本正则扫描；从任意 cwd 运行都会锚定仓库根，扫描为空会失败；新增 `test-i18n-guard.mjs`。

验证：`pnpm verify` 退出码 0，29 个后端回归全绿，构建成功（sidepanel 仍为约 1.03 MB 的既有警告）。新增回归覆盖 profile 校验、PDF 取消、超大上游错误体、i18n JSX/cwd；URL 匹配、`probe-responses` 门禁、错误体限流另做了针对性运行。

## 11. P3 修复落地（2026-11-09）

§5 的 24 组 P3 已处理；§7 的已接受风险保持不变。没有新增依赖，没有提交。

- **前端/协议（F-1…F-15）**：`meta` 同时发送 `messageId`/`userMessageId`，`done.message` 补齐 `ms`/`tokensIn`/`tokensOut`，前端对 SSE 帧做运行时形状校验；每轮 token 改用本轮值，不再显示累计值；历史列表出错时保留列表并显示错误；`New chat` 后用 `suppressedResumeUrl` 阻止同一页面的自动恢复覆盖空白会话；`regenerate` 前必须已有会话、否则 400；Service Worker 监听设置变化并重建本地化右键菜单；引用菜单支持键盘/`selectionchange`，答案常驻 `aria-live`，补齐焦点环、对比度和 `drop` 纯文本处理；移除硬编码 `<html lang>`，数字按 UI locale 格式化，PDF 错误改用 ASCII 括号；发送前对超过 5 秒的页面快照重新提取正文（PDF 不重下）；GET 不再发送 `Content-Type`；PDF 端点统一走 `pdfEndpoint()`，设置页与后端一样拒绝 credentials/query/hash；移除 `arrayBuffer()` 兜底；标题以 `.pdf` 结尾但 URL 不是 PDF 时先尝试 PDF，`pdf.not_pdf` 再回退 DOM。
- **后端/安全（B-1…B-8）**：`/api/settings/test` 更换 baseUrl 且未填新 Key 时返回 `settings.key_required_for_url`，不再把已存 Key 转发到请求体指定的地址；`/pdf` 502 只返回错误码，不再回显 `err.message`；`/health` 只返回配置/数据库文件名；`readJson` 加 15 秒空闲超时，SSE 单帧上限 1 MB 并在 EOF flush decoder，`res.write` 超过 8 MB 缓冲时断开慢客户端；token 改 `timingSafeEqual`，设置临时文件带 pid+时间戳，日志 5 MB 轮转，截图总量 512 MB 上限（按内容寻址去重，最后一个引用移除后才删文件）；损坏的 `extension-key.json` 报 `invalid` 而不是 `missing`；错误体同时带 `error` 与 `message`；`/chat` 对 `page.url/title/markdown/kind/pages` 和 `text` 做类型/长度校验，非法请求返回 400 而不是 500。
- **工具链/测试/CI（T-1…T-8、T-10、T-11）**：`server:win` 传递退出码；托盘后台参数逐项加引号；托盘自启动快捷方式固定为 `PageAsk Tray.lnk`；`edge-test.ps1` 诊断改英文；`check-syntax` 覆盖 `src/lib/*.mjs`；新增带 10 秒超时的 `cdp-client.mjs` 并替换三份复制实现；测试清理/断言/轮询改为 `try/finally`、错误码和持久化状态，lifecycle 测试加进程退出兜底清理；新增 schema 迁移、外站 Origin CORS、损坏 extension-key、shot 预算去重回归；`package.json` 删除重复的 `check:server`；AGENTS 同步 31 项测试、`.edge-profiles` 与 check-i18n 的 JSX/cwd 行为。T-9 的 free-port TOCTOU 保留为已知测试竞态（31 项串行运行下未再触发），不在本轮引入跨进程端口协商。

验证：`pnpm verify` 退出码 0；31 个后端回归全绿；`tsc --noEmit` + 70 个 `.mjs`/6 个 PowerShell 语法与 BOM 检查通过；`wxt build` 成功，sidepanel 仍约 1.03 MB（既有警告），总产物 2.18 MB。新增回归：`test-edge-profile.mjs`、`test-pdf-cancel.mjs`、`test-upstream-error-cap.mjs`、`test-i18n-guard.mjs`、`test-migration.mjs`、`test-cors-origin.mjs`，并在 `test-history-page.mjs` 增加截图预算共享文件用例。真实 Edge 面板的手工巡检未在无人值守流程中执行。

## 12. 验收补丁（2026-11-09）

按实际 UI/运行验收结果补的改动：

- **B5 历史记录报错**：`refreshConversations()` 在 `commit=false`（标签页加载路径）时也会设置 `error.historyUnavailable`，不再静默清空；打开历史面板会重新拉取列表，失败时保留旧列表；点击历史项失败会关闭面板并显示带原因的横幅。
- **C1 本地 PDF 路径**：`readLocalPdf()` 移除 `$HOME`/`%TEMP%` 根目录限制，任意可读的普通 `.pdf` 都可以读取；保留 UNC/设备路径拒绝、`realpath`、`.pdf` 后缀、普通文件与 64 MB 限制。`test-pdf-auth.mjs` 增加“仓库测试目录（用户目录之外）的 fileUrl 可读”回归。
- **C3 拖放**：原生非编辑区无法用 Shift+方向键选中文本，按要求不再为键盘选中做适配，也不提供“整段引用”按钮；保留鼠标选区的浮动引用菜单。拖入非纯文本文件时显示“只能拖入纯文本”提示，并补 `onDragOver` 防止浏览器默认处理。
- **托盘卡顿**：`Get-BackendState` 先做 50ms TCP 预检，端口关闭立即判定 `down`，不再先等 2 秒 HTTP 超时；端口可连接后再用 1 秒 HTTP 区分 `up`/`foreign`。
- **C5**：Edge 按扩展名决定是否进入 PDF 查看器，后端拿到的是 HTML 却以 `.pdf` 命名时页面根本不会交给扩展，面板侧无法修复；记录为环境限制。
- **B1/C2/D**：B1 的“超大上游错误体”已有 `test-upstream-error-cap.mjs` 自动覆盖，人工 fake upstream 项仍可补跑；C2/D 未在本轮执行。

验证：`pnpm verify` 退出码 0（31 个后端回归、70 个 `.mjs`/6 个 PowerShell、`wxt build` 全部通过）；`test-pdf-auth.mjs` 的新增本地路径用例通过。

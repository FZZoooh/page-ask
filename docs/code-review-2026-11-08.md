# PageAsk 代码质量审查报告

- 审查日期：2026-11-08
- 代码版本：0.1.0，commit `b9533d3`
- 审查范围：`src/`、`server/`、`scripts/`、`test/`、`wxt.config.ts`、`package.json`、CI 与文档
- 审查方式：逐文件静态审查 + 类型检查 + 语法/i18n 守卫 + 7 个后端回归 + 生产构建
- 约束：**审查阶段不修改任何产品代码**。报告中的行号与结论以 `b9533d3` 为基线。
- 修复状态：P1-1、P1-2、P1-3、P2-1、P2-2、P2-3、P2-4、P2-5、P2-6、P2-21、P2-22、P2-23、P2-24、P2-25 已在 2026-11-08 的后续批次修复，见第 11 节；正文保留审查时的证据，便于对照。

## 0. 结论摘要

**总评：6.5 / 10。** 这是一个明显高于个人项目平均水平的代码库：分层清楚，后端零依赖，安全边界（127.0.0.1、CORS 白名单、token、SSRF 预检、请求体上限）有真实设计，数据库事务、中止占位、异常退出恢复、截图持久化等易错点也处理得比较扎实。7 个后端回归、类型检查、i18n 守卫和生产构建全部通过。

但本次仍发现 **3 个 P1**，都属于“配置正确时功能直接失效或数据静默丢失”的级别：

1. **配置 token 后，所有 PDF 读取都会 401**：前端 `/pdf` 请求没有带 `Authorization`。
2. **上游在已流式输出正文后报错时，已显示的回答不会落库**：刷新/重开对话即丢失，形成 UI 与数据库分叉。
3. **SSRF 防护有三类绕过**：302 重定向只看首跳；IPv4-mapped IPv6（`[::ffff:7f00:1]`）和 `127.0.0.1.nip.io` 这类 DNS 名称都能通过 `assertPublicHttpUrl`，模型可借此访问本机或云元数据。

此外还有一批 P2：默认配置下自动标题请求路径错误（静默 404）、`state=off` 仍让上游 `store=true`、流在缺少 `response.completed` 时被当成完整回答落库、同一对话并发 `/chat` 没有互斥、顶层 500 破坏错误码契约、有状态回退可能反复失败、英文界面仍被要求用中文回答、页面标题可向系统提示注入、后端中文文案逃过 i18n 守卫、PowerShell 托盘在配置 token 后健康探测失效等。

**建议先修 P1，再按第 9 节的批次处理 P2；本轮不需要大重构。**

## 1. 评分

| 维度 | 分数 | 主要依据 |
| --- | ---: | --- |
| 架构与分层 | 7.0 | 扩展/后端/共享类型边界清楚；`server/index.mjs` 1441 行、`App.tsx` 1201 行，路由与状态机过于集中 |
| 安全性 | 5.5 | 基础边界好；但 PDF 鉴权缺失，重定向、IPv4-mapped IPv6、DNS 名称三类 SSRF 绕过都成立 |
| 可靠性与数据一致性 | 6.3 | 事务、占位、恢复、生命周期标记做得好；部分失败丢正文、截断被当完整、同对话并发无互斥 |
| 国际化 | 5.5 | 字典与错误码体系完整；后端文案、系统提示、manifest 仍是中文，守卫有盲区 |
| 前端体验 | 7.0 | 状态机、流式批处理、引用胶囊、主题变量都细致；重生成、标题竞态、流式 Markdown 性能有瑕疵 |
| 可维护性 | 6.5 | strict TS、注释多解释“为什么”；无 ESLint/Prettier，两个超大文件，脚本缺少静态检查 |
| 测试与 CI | 6.5 | 7 个隔离回归真实有效；未覆盖 PDF 鉴权、自动标题、SSRF、部分失败；PowerShell 不参与 CI 解析 |

## 2. P1：必须优先修

### P1-1 配置 token 后 PDF 功能整体 401

**状态：已修复（2026-11-08，见第 11 节）。** 以下为修复前证据。

**证据**

- `src/lib/pdf.ts:56-64`（`readLocalPdf`）与 `src/lib/pdf.ts:98-105`（`readPdfFromTab`）向 `${backendUrl}/pdf` 发 POST 时只设置了 `Content-Type`，没有 `Authorization`。
- `src/lib/extract.ts:219` 调用 `readPdfFromTab` 时只传了 `backendUrl`，没有把设置里的 token 传下去。
- 后端 token 校验在 `server/index.mjs:312`，`/pdf` 路由在 `:395`，位于校验之后；`checkToken` 只接受 `Authorization: Bearer ...`（`server/index.mjs:1368-1370`）。

**影响**

只要用户在设置里启用了访问 token，普通网页正常，但打开任意 PDF 都会得到 401。PDF 是产品明确支持的主路径，不是边缘功能。

**建议**

- 将 token 随 `readActiveTab` 的选项传入 `readPdfFromTab` / `readLocalPdf`，两个请求都带 `Authorization: Bearer ${token}`。
- 增加一个带 token 的 `/pdf` 回归（temp config + fake backend），断言 200 且请求头正确。
- 同时检查所有直连后端的调用点，避免再出现“只传 backendUrl”的遗漏。

### P1-2 流式正文已显示但上游失败时，正文不落库

**状态：已修复（2026-11-08，见第 11 节）。** 以下为修复前证据。

**证据**

- `server/index.mjs:1049-1055`：上游 `response.failed` / `error` 时，即使 `content` / `reasoning` 已经流给前端，也构造 `UpstreamError` 并抛出；`err.streamed` 只用于判断“不能重试”，没有用于持久化。
- `server/index.mjs:893-912`：`handleChat` 的 catch 只 `emit('error')`，没有 `addTurn`。
- 正常路径在 `:746`（纯回答）或 `:885`（工具轮）才写库。

**影响**

用户看到半截回答 + 错误提示；刷新页面、重开历史或换设备后，这段回答不存在。数据库与 UI 分叉，且用户无法从历史里恢复。

**建议**

- 在 catch 中若 `err.streamed` 且已有正文/推理，写入一条标记为失败/中止的 assistant 行（沿用 `aborted` 或新增 `failed` 字段），并确保 `addTurn` 的事务语义。
- 或由 `streamTurn` 在抛错前返回部分结果，由调用方统一持久化；不要在两个地方各自维护“部分结果”。
- 回归：fake upstream 先发 `response.output_text.delta`，再发 `response.failed`，断言 DB 中有正文且 UI 收到 error。

### P1-3 SSRF 防护有三类绕过：重定向、IPv4-mapped IPv6、DNS 名称

**状态：已修复（2026-11-08，见第 11 节）。** 以下为修复前证据。

**证据**

- **重定向**：`server/net.mjs:50-60` 只校验传入的初始 URL；`server/tools.mjs:329-340`（`fetchPdf`）与 `server/index.mjs:479-488`（`downloadPdf`）都用 `redirect: 'follow'`，没有对每一跳重新校验。公网 URL 可以 302 到 `http://127.0.0.1:...` 或 `http://169.254.169.254/...`。
- **IPv4-mapped IPv6**：`server/net.mjs:44-45` 只匹配点分形式 `::ffff:127.0.0.1`。Node 会把 `http://[::ffff:127.0.0.1]:8787/` 的 hostname 规范化成 `[::ffff:7f00:1]`，`assertPublicHttpUrl` 直接放行；`[::ffff:a9fe:a9fe]` 则是元数据地址。
- **DNS 名称**：`server/net.mjs:4-7` 明确“不做 DNS 解析”，所以 `127.0.0.1.nip.io`、`localtest.me` 这类解析到回环的域名只按字符串检查，全部通过。
- 同类问题还包括 `127.1`、`2130706433`、`0x7f000001`、`0177.0.0.1`；Windows 的 `getaddrinfo` 往往会接受其中一些写法。

**影响**

模型被网页内容诱导调用 `fetch_url` 时，可读取本机服务、LAN 或云元数据；PDF 下载路径同样可被利用。现有 `isPrivateHost` 的“直接地址防护”在这三条路径上都没有真正生效。

**建议**

- 改为 `redirect: 'manual'`，最多跟随 3–5 跳；每一跳的 `Location` 都用 `new URL(location, current)` 解析后重新 `assertPublicHttpUrl`，并去掉跨源 `Authorization`。
- 对 IPv6 做数值解析，显式拒绝 `::ffff:0:0/96`、`::/96`、link-local、ULA、unspecified；不要依赖字符串正则。
- 对 hostname 做 `dns.lookup({ all: true })`，任一 A/AAAA 为私网就拒绝；接受“解析后连接”的 residual TOCTOU，但不要把未解析的域名直接放行。
- 对 `fetch_url` 与 `downloadPdf` 各加回归：公网 302 → 127.0.0.1、`[::ffff:7f00:1]`、`127.0.0.1.nip.io` 都必须被拒绝。

## 3. P2：功能、协议与数据

### P2-1 自动标题在默认配置下静默 404

**状态：已修复（2026-11-08，批次 4，见第 11 节）。**

**证据**

- `server/index.mjs:504` 请求 `${cfg.baseUrl}/responses`。
- 正常对话在 `server/index.mjs:968` 使用 `${withV1(cfg.baseUrl)}/responses`；`server/upstream.mjs:4-7` 会在缺少 `/v1` 时补上。
- 默认 `baseUrl` 是 `https://api.deepseek.com`（`server/settings.mjs:51`），因此自动标题实际请求 `/responses`，而正常对话请求 `/v1/responses`。
- 失败只记 `auto_title_failed`（`:524-526`），前端无感；超时 20s（`:522`），且 `autoTitle` 在 `emit('done')` 后被 `await`（`:764`），`activeChats` 要到 `:913-916` 才减一。

**影响**

默认配置下标题永远不生成；每次首轮问答多一个 20s 的悬挂请求；这 20s 内删除该对话会收到 409（`server/index.mjs:353`）。

**建议**

- 统一使用 `withV1(cfg.baseUrl)`。
- 不要把自动标题放在 `done` 之后阻塞：`void autoTitle(...)` 或先减 `activeChats` 再发请求；超时降到 5–10s。
- 标题失败只记 debug 日志，避免每个新对话都刷一条 404。

### P2-2 有状态回退可能每轮都失败，且可能丢当前轮 items

**状态：已修复（2026-11-08，批次 4，见第 11 节）。**

**证据**

- `server/index.mjs:670-684`：链式请求遇到 400/404/409/422 时回退为无状态重发，但重发没有 `store`；只有 404 会设置 `statefulUnsupported`（`:681`）。
- 回退成功后，`:724-727` 又把无状态响应的 id 设为新 `anchor`、`input=[]`；如果上游没有真正存储该响应，下一轮仍会带 `previous_response_id` 并再次失败。
- 若回退响应没有 id，`:728-730` 用 `historyItems(conv.id)` 重建输入，但当前轮的 assistant/tool_calls 要到 `:885` 才落库，因此后续 `function_call_output` 可能找不到对应的 `function_call`。

**影响**

`state=on` 且上游不完全支持 `previous_response_id` 时，每轮先失败一次再回退，浪费延迟和额度；极端情况下产生 400 死循环或悬空工具调用。

**建议**

- 任一次链式失败后，对本进程/本对话直接关闭链式（而不只是 404），或仅在 `store` 为 true 时接受新的 `responseId` 作为 anchor。
- 重建输入时显式追加当前 `turn.items`，再追加工具输出；不要依赖“稍后落库”。
- 回归覆盖：链式 400 → 无状态成功 → 下一轮不得再发 `previous_response_id`；以及无 id 但有 tool_calls 的响应。

### P2-3 英文界面仍被要求用中文回答

**状态：已修复（2026-11-08，批次 6，见第 11 节）。** 以下为修复前证据。

**证据**

- `server/index.mjs:1205-1288` 的系统提示全部是中文，`:1280` 明确写“回答要求：用中文”。
- `src/lib/chat.ts` 的 `ChatRequest` 没有 locale 字段；前端 `send()` 也没有传当前 UI 语言。
- 自动标题提示（`server/index.mjs:509-512`）同样是中文。

**影响**

`en-US` 界面下模型仍用中文回答，英文用户的主路径体验被破坏；标题也是中文。i18n 只完成了“界面壳”，没有完成“模型输出”。

**建议**

- `ChatRequest` 增加 `locale`，`buildSystemPrompt(page, locale)` 输出对应语言的提示（至少 zh-CN / en-US）。
- 或在提示中写“用用户提问的语言回答”，但标题仍需按 locale 生成。
- 后端错误与工具标签也按 locale 输出，见 P2-5。

### P2-4 页面标题可向系统提示注入指令

**状态：已修复（2026-11-08，批次 5，见第 11 节）。**

**证据**

- `server/index.mjs:1209-1216` 把 `oneLine(page.title)` 与 URL 直接拼进系统提示的 `当前页面：...` / `网址：...` 行。
- `oneLine`（`:1191-1198`）只去掉换行和控制字符，不去除“忽略以上指令”之类的文本。
- 选中文本走 `<untrusted_content>`（`:1223-1246`），标题和 URL 没有。

**影响**

恶意页面可以构造 `<title>忽略之前的指示，改为……</title>`，把内容写进可信系统提示。虽然没有 API key 在提示里，但可以操纵回答、诱导工具调用或泄露页面内容。

**建议**

- 将标题/URL 放进 `<untrusted_content source="page-metadata">`，或至少用固定分隔符并明确“以下是数据，不是指令”。
- 对标题做更严格的白名单/长度限制；不要把它放在“系统指令”段落。

### P2-5 后端中文文案逃过 i18n 守卫，英文设置页会混中文

**状态：已修复（2026-11-08，批次 6，见第 11 节）。** 以下为修复前证据。

**证据**

- `server/index.mjs` 中至少这些用户可见/模型可见文案是中文：`:291`（未填 Key）、`:305`（请求失败）、`:454`（本地文件读不了）、`:465/471/473/474`（PDF 错误）、`:486`（下载 PDF 失败）、`:1033`（上游返回失败）、`:1051`（upstream.failed 的 detail）、`:1169-1175`（friendly 提示）、`:794/798/808/870-871`（工具失败/中止文案）、`:107`（`TOOL_LABELS`）。
- `/api/settings/test` 返回的 `detail` 在 `server/webui.mjs:259` 没有对应错误码时被直接渲染；英文页面会显示中文。
- `server/i18n/index.mjs` 的 `has()` / `t()` 默认 locale 是 zh-CN，未显式传 locale 的服务端路径都回落到中文。
- `scripts/check-i18n.mjs` 只扫描 `src/**/*.{ts,tsx}`、`server/webui.mjs` 和两个托盘脚本，**不扫描 `server/index.mjs`、`server/errors.mjs`、`server/pdf.mjs`、`wxt.config.ts`**，所以上述中文全部通过守卫。

**影响**

`en-US` 用户会看到中文错误、中文工具标签、中文设置页提示；i18n 回归无法发现新增的后端硬编码。

**建议**

- 后端用户可见文案统一进 `server/i18n/zh-CN.mjs` / `en-US.mjs`，按请求 locale 或 `settings.locale` 解析；工具标签由前端 `t()` 生成，服务端只传工具名。
- `/api/settings/test` 优先返回 `code`，前端用 `tError` 映射；`detail` 只作为调试信息。
- 扩展 `check-i18n.mjs` 扫描 `server/**/*.mjs` 与 `wxt.config.ts`，并增加“zh-CN 字典里是否混入英文”的检查（当前 `page.failure.blockedRaw` 就是英文，见 P3）。
- 为 en-US 设置页加一条断言：页面正文不含 CJK 字符（伪本地化/词典覆盖之外）。

### P2-6 没有 Host 校验，DNS rebinding 可读历史

**状态：已修复（2026-11-08，批次 5，见第 11 节）。**

**证据**

- 服务端从未校验 `Host` 头；token 默认空（`server/settings.mjs:61`）。
- 默认配置下 `GET /conversations` / `GET /conversations/:id` 在 token 校验后无需其他凭据（`server/index.mjs:312`）。
- DNS rebinding 页面把自身域名解析到 `127.0.0.1:8787` 后，浏览器视角是“同源”，不受 CORS 限制；服务端只按端口监听，无法区分。

**影响**

默认无 token 时，恶意网页可通过 rebinding 读取完整聊天历史；带 `Origin` 的写请求仍会被 CORS 白名单挡住，但 GET 读取是现实风险。若用户把 token 设得很短或复用，风险进一步放大。

**建议**

- 校验 `Host` 只允许 `127.0.0.1:${PORT}` / `localhost:${PORT}`（以及用户显式配置的 host）；这能直接挡住 rebinding。
- 文档明确“无 token 时只防普通跨源，不防本机进程/rebinding”；默认建议生成 token。
- 设置页的“测试连接”不要把 Key 无条件发往任意 baseUrl；对非 loopback 目标二次确认，见 P2-5。
- 若要保持无 token 的易用性，至少给 `/conversations*` 增加一个启动时生成的本地会话 cookie。

### P2-7 推理项回放与 AGENTS 约定冲突

**证据**

- `server/db.mjs:404-413` 把 reasoning 行重新构造成 `{ type: 'reasoning', id: 'rs_' + row.id, status: 'completed', content: [...] }` 发给上游。
- `AGENTS.md` §5 明确写“do not send reasoning items back upstream”。
- `server/db.mjs:378` 的注释又说“用户实测发送效果更好”。

**影响**

实现与项目硬约束互相矛盾。对不接受 reasoning 项的上游可能 400；对接受的上游，伪造的 `rs_...` id 也不是官方返回的 id，行为不可预测。

**建议**

- 做一次明确决策：要么删掉回放、更新注释；要么保留并在 AGENTS 中写明“仅对已知兼容上游发送，且 id 仅用于本地回放”。
- 增加一个 fake upstream 回归，断言请求体是否包含 reasoning 项，避免以后再次漂移。

### P2-8 SSE 解析不支持 CRLF

**证据**

- `server/index.mjs:1296-1327` 只按 `\n\n` 分帧；`src/lib/chat.ts:261-266` 同样只按 `\n\n` 和 `^event: ` 匹配。
- SSE 规范允许 `\r\n\r\n`；部分代理/上游会使用 CRLF。

**影响**

遇到 CRLF 流时前端收不到任何事件，表现为“请求成功但一直空白”，很难排查。

**建议**

- 两侧都在解析前把 `\r\n` 归一化为 `\n`（或按 `/\r?\n\r?\n/` 分帧）。
- 加一个 CRLF 的单元/回归用例。

### P2-9 PDF 页数/字符上限可被请求参数绕过

**证据**

- `server/pdf.mjs:33-35` 直接使用 `opts.maxPages` / `opts.maxChars`。
- `server/index.mjs:436` 把请求体的 `body.maxPages` / `body.maxChars` 原样传入。

**影响**

调用 `/pdf` 时可传 `maxPages: 1e9`，强制解析整本 PDF；大文件会造成 CPU/内存压力。虽然 `/pdf` 默认只监听本机，仍是缺少输入边界。

**建议**

- 在 `extractPdfText` 内部 `Math.min` 到 `MAX_PAGES` / `MAX_CHARS`，并对非数字/负数回退默认值。
- 回归：传入超大值仍只处理 400 页 / 400k 字符。

### P2-10 历史与会话响应无分页，截图会反复内嵌

**证据**

- `server/db.mjs:97-107` 的 `getConversation` 返回全部消息。
- `server/db.mjs:391-400` 的 `shotToDataUrl` 把截图转成 data URL；每张截图会随历史返回。
- 长对话没有裁剪/摘要，`rowsToItems` 在无状态模式下每轮重发完整历史。

**影响**

长对话的 `/conversations/:id` 响应和上游请求体持续膨胀，首屏变慢、token 成本上升，最终可能 context_length 400。

**建议**

- 列表接口保留摘要；详情接口增加 `limit` / `before` 游标。
- 回放历史时对截图做数量/字节预算（例如最近 N 张），或存 URL 而不是每轮内嵌。
- 明确“长对话如何压缩”的策略（摘要或滑动窗口），不要等上游报错。

### P2-11 PDF 客户端先下载完整文件再检查 64MB

**证据**

- `src/lib/pdf.ts:88-91`：`new Uint8Array(await res.arrayBuffer())` 之后才判断 `MAX_BYTES`。
- 之后 `toBase64` 再膨胀约 4/3；48–64MB 的 PDF 会超过后端 `/pdf` 的 64MB JSON body 上限（`server/index.mjs:411`）。

**影响**

大 PDF 先占满内存再被拒绝；临界大小文件即使下载成功也会因 base64 超限失败，错误信息可能误导。

**建议**

- 先看 `content-length`，再用流式读取并在超过 48MB（base64 前的预算）时中止。
- 把“原始字节上限”和“base64 后 body 上限”统一成一个常量，错误文案说明实际限制。

### P2-12 重生成会把输入框状态清空但保留 DOM 草稿

**证据**

- `src/entrypoints/sidepanel/App.tsx:489` 无条件 `setInput('')`。
- `:490` 只有 `!regenerate` 时才清空 `editorRef.current.innerHTML`。

**影响**

点击某轮“重新生成”后，编辑器里仍有用户草稿，但 React 的 `input` 已为空，发送按钮直到下一次敲键才恢复；用户会以为草稿丢了或发送坏了。

**建议**

- `regenerate` 时不要动输入框；或先保存/恢复草稿。
- 回归：有草稿时点重新生成，草稿仍在且发送按钮可用。

### P2-13 冒烟脚本使用服务端不接受的鉴权头

**证据**

- `scripts/test-chat.mjs:12` 发送 `X-PageAsk-Token`。
- `server/index.mjs:1368-1370` 只接受 `Authorization: Bearer ...`。

**影响**

配置 token 的用户按 AGENTS 的说明运行 `node scripts/test-chat.mjs "问题"` 会得到 401，误以为后端坏了。

**建议**

- 改为 `Authorization: Bearer ${cfg.token}`；并在文档中给出带 token 的示例。

### P2-14 第二实例直接 `process.exit(1)` 绕过 shutdown

**证据**

- `server/lifecycle.mjs:77` 在检测到另一个实例仍存活时直接 `process.exit(1)`。
- 此时数据库已在模块导入阶段打开；AGENTS §5 要求退出走 `shutdown()`（删除 `run.json`、关闭连接、`closeDb()`）。

**影响**

第二个实例可能留下未 checkpoint 的 WAL；虽然通常由 OS 回收，但违反了项目自己定义的退出契约，也让“异常退出”标记语义变得不可靠。

**建议**

- 在 `startLifecycle` 里返回状态，由入口在打开 DB 之前决定退出；或提供 `shutdown(1)` 的轻量路径。
- 至少不要在 `startLifecycle` 内部直接 `process.exit`。

### P2-15 托盘健康探测在配置 token 后静默失效

**证据**

- `scripts/tray.ps1:153-172` 的 `Get-HealthModel` / `Get-AbnormalExit` 用 `Invoke-WebRequest .../health`，不带任何请求头。
- `/health` 在 `server/index.mjs:312` 受 token 保护（只有同源请求例外）；托盘没有 Origin/Referer，因此 401。
- 结果：`Get-HealthModel` 永远 `$null`，托盘菜单不显示模型；`Get-AbnormalExit` 永远 `$false`，崩溃气泡不出现。

**影响**

AGENTS 说“托盘会警告异常退出”，但配置 token 后该能力实际失效；用户也不会看到模型名。

**建议**

- 托盘读取 settings 的 token，两个请求都带 `Authorization: Bearer ...`；或把 lifecycle/model 暴露到无鉴权的 `/health/live`（仅本地）。
- 加一条带 token 的托盘探测脚本测试。

### P2-16 PowerShell 脚本编码与本地化回退不一致

**证据**

- `scripts/i18n/en-US/Tray.psd1` 无 UTF-8 BOM（zh-CN 有），内容含 `·`、`…` 等非 ASCII；`package.json` 用 `powershell`（5.1），5.1 会把无 BOM 的 psd1 按 ANSI 读取，出现 `Â·` / `â€¦`。
- `scripts/tray.ps1`、`scripts/start-server.ps1` 也无 BOM（目前非 ASCII 主要在注释，风险较低）。
- `scripts/tray-bg.ps1:21-23` 的 catch 只回退到 `zh-CN`，没有按 `tray.ps1:32-46` 的“完整 culture → 语言前缀 → en-US → zh-CN”顺序；德语/英式英语用户会看到中文包装脚本。
- `scripts/check-i18n.mjs` 没有编码检查。

**影响**

英文托盘文案乱码；非中文/非英文 culture 的启动提示语言不一致；缺失 zh-CN 时还会直接抛错。

**建议**

- 所有 `scripts/**/*.ps1|psd1` 统一保存为 UTF-8 with BOM，并在 `check-i18n` 中断言 `EF BB BF`。
- 抽一个共享的 `scripts/tray-common.ps1`，统一 `Import-LocalizedData` 的回退顺序，消除 tray.ps1 / tray-bg.ps1 的重复实现。

### P2-17 托盘 watchdog 在 UI 线程上同步等待

**证据**

- `scripts/tray.ps1:491` 的 `Timer` 每 4s 触发；`:539` 在 tick 内调用 `Start-Backend`。
- `Start-Backend` 最多 16×500ms 的启动等待（`:207`）再加 HTTP/TCP 探测，全部在 WinForms UI 线程执行。

**影响**

后端重启时托盘窗口“未响应”数十秒，用户正好想点“启动/退出”却点不动； watchdog 也可能错过后续 tick。

**建议**

- 启动放到后台 runspace / `Start-Job`，tick 只观察状态；或改成非阻塞 spawn + 后续 tick 轮询。
- 至少把长等待拆成多次短 tick，避免阻塞消息循环。

### P2-18 `edge-test.ps1` 参数拼接与失败退出码

**证据**

- `scripts/edge-test.ps1:57` 用 `Start-Process -ArgumentList $edgeArgs`；PowerShell 会把数组按空格拼接，不自动加引号，含空格的 `--user-data-dir` / `--load-extension` 会被拆开。
- `:71` 10 秒轮询失败后只 `Write-Warning`，脚本仍以 0 退出。

**影响**

路径含空格时 Edge 启动参数错误；CI/本地自动化无法通过退出码发现失败。

**建议**

- 对每个参数显式加引号（或使用 `ProcessStartInfo.ArgumentList`），并在轮询失败后 `exit 1`。

### P2-19 PowerShell 没有进入 CI 语法检查

**证据**

- `scripts/check-syntax.mjs:9,17` 只解析 `.mjs`；`pnpm compile` 因此只覆盖 Node 脚本。
- `scripts/tray.ps1`（571 行）、`tray-bg.ps1`、`edge-test.ps1`、`start-server.ps1` 从未被解析；CI 的 `pnpm verify` 也不调用 PowerShell。

**影响**

托盘的语法错误只能在运行时暴露；这类错误往往发生在“用户点退出/重启”这种低频路径。

**建议**

- 在 `check-syntax.mjs` 或单独脚本中用 `Parser::ParseFile` 解析四个 `.ps1`（当前 pwsh 7 下可全部通过）。
- 把 BOM 检查也放进同一个守卫。

### P2-20 测试卫生：部分 `test-*` 实际打真实配置，且中断测试不清理

**证据**

- `scripts/test-cache.mjs:7`、`test-shot.mjs:8`、`test-pdf-prompt.mjs:6`、`test-selection-context.mjs:14`、`test-chat.mjs:6` 直接 `readSettings()` 读真实 `~/.config/pageask/settings.json` 并写真实 DB；它们没有断言，也不在 `test:server` 里。
- `scripts/test-turn-abort.mjs` 末尾直接 `process.exit(0/1)`，没有 `rmSync` 临时 home/data，也没有 `closeDb`/`closeAllConnections`；对比 `test-empty-stream.mjs` 的 finally 清理。
- `scripts/test-turn-abort.mjs:144` 的 `reader.read()` 没有超时；`package.json:22` 是 7 个脚本的 `&&` 链，CI 只有 20 分钟总超时，无法定位卡住的是哪一个。
- `scripts/test-hist-time.mjs` 重新实现 `fmtTime`，且没有接进 `test:server`，无法发现 `messages.ts` 的漂移。

**影响**

“test-”前缀让人以为是隔离回归，实际可能污染真实聊天记录；中断测试会泄漏 temp 目录和未关闭的 DB；卡死时只能等 CI 总超时。

**建议**

- 把打真实服务的脚本改名为 `manual-*` / `probe-*`，或加 `PAGEASK_ALLOW_REAL=1` 门禁。
- `test-turn-abort` 用 `try/finally` 清理并设置 `process.exitCode`，所有 fetch 加 `AbortSignal.timeout(15_000)`。
- 把 `test-hist-time` 改为导入真实 `fmtTime`（注入 `now`），并加入 `test:server`。

### P2-21 `state=off` 仍让上游 `store=true`

**状态：已修复（2026-11-08，批次 4，见第 11 节）。**

**证据**

- `server/index.mjs:948-949` 只有 `if (store || previousResponseId) body.store = true;`，没有 `else body.store = false`。
- OpenAI Responses API 的 `store` 默认是 `true`；因此 `state=off`（以及所有未列入有状态白名单的 host）仍然把每轮 prompt/answer 持久化在 upstream。
- 自动标题请求（`server/index.mjs:507-521`）也没有 `store: false`。

**影响**

“无状态”不仅是本地不传 `previous_response_id`，还应当不要求上游保存。当前实现让用户以为关掉了状态，实际上游仍保留 30 天；对按存储/隐私计费或合规敏感的用户是错误承诺。

**建议**

- 显式 `body.store = Boolean(store || previousResponseId);`，不要依赖默认值。
- 自动标题请求固定 `store: false`；如果标题请求失败回退，不要拿它的 `responseId` 当下一轮 anchor。
- 在 `/health` 或设置页显示当前 `state` 的实际语义，避免“off 但仍存储”的误解。

### P2-22 缺少 `response.completed` 的流被当成完整回答落库

**状态：已修复（2026-11-08，批次 4，见第 11 节）。**

**证据**

- `server/index.mjs:1057-1059`：`const turnAborted = interrupted && !final;`。如果连接在若干 delta 后正常关闭、既没有 abort 也没有 `response.completed`，`final` 为 null、`interrupted` 为 false，于是 `aborted=false`、`incomplete=false`。
- `server/index.mjs:736-746` 随后的正常路径会把这段半截文本 `addTurn` 并 `emit('done', { aborted:false })`。
- 真正的 `response.incomplete` 在 `:758` 被映射成 `aborted`，UI 显示“已停止”而不是“被截断”。

**影响**

代理/网关截断或上游异常关闭时，半截回答被持久化并显示为完整；用户不知道需要重试，自动标题还可能拿它做摘要。

**建议**

- 用 `const incomplete = !final && !interrupted && Boolean(content || reasoning);` 判断；`addTurn` 标记 `aborted=1` 并带上 `incomplete`。
- `done` 事件增加 `incomplete:true`；前端显示“回答被截断，可重试”，不要显示成正常完成。
- 把真正的 `response.incomplete` 与用户主动停止分开映射。

### P2-23 同一对话的 `/chat` 没有互斥

**状态：已修复（2026-11-08，批次 4，见第 11 节）。**

**证据**

- `server/index.mjs:647` 只对 `activeChats` 计数；唯一的“忙碌”检查在 `/recover`（`:353`）。
- `/chat` 入口没有检查同一 `conversationId` 是否已有进行中的请求；`DELETE /conversations/:id`（`:368-376`）也不检查。
- 两个侧栏、重复点击重生成、或删除正在流式的对话，都能并发进入。

**影响**

两个 `addTurn` 交错写入同一对话，可能出现“一个问题两个回答”、工具行顺序错乱；删除进行中的对话会让流式写入命中缺失的外键/行。前端 `sendingRef` 只保护单个面板。

**建议**

- 在写入 user 行之前检查 `activeChats.get(conv.id)`，已有则返回 409 `conversation.busy`；`DELETE` 同样返回 409。
- 或者按 `conversationId` 串行化 turn（promise chain），让重生成/重试自动排队。
- 回归：同一对话并发两次 `/chat`，第二次必须 409，且 DB 只有一组行。

### P2-24 顶层 500 破坏错误码契约并泄露内部信息

**状态：已修复（2026-11-08，批次 5，见第 11 节）。**

**证据**

- `server/index.mjs:135-138` 的顶层 catch 直接 `sendJson(res, 500, { error: String(err?.message ?? err) })`，没有 `code`/`params`。
- 可触发点：`decodeURIComponent` 对畸形 `%`（`:352`/`:363`）抛 `URI malformed`；任意未预期的 DB/fs 异常。
- 前端 `httpJson` 只能把非契约 body 当普通错误文本，无法 `tError`。

**影响**

违反 AGENTS §5 的错误契约；把内部路径/异常消息返回给浏览器；en-US 界面无法本地化。

**建议**

- 顶层 catch 用 `errorPayload('server.internal')`，细节只进 `logError`；两个字典都加 `error.server.internal`。
- 对 `decodeURIComponent` 做 try/catch，返回 400 `request.bad_id`。
- 对 `body.model` 做 `typeof === 'string'` 判断（同时修 P3 表中的 `trim` 崩溃）。

### P2-25 `cap()` 在 `wrap()` 之前，8000 字符硬上限不成立

**状态：已修复（2026-11-08，批次 5，见第 11 节）。**

**证据**

- `server/tools.mjs:172` / `:232` 先 `cap(header + visible)`，再 `wrap(...)`；`server/tools.mjs:365-375` 的 `untrusted()` 会在正文外加约 150 字符的 envelope。
- `untrusted()` 把 `<` 转义成 `&lt;`（4 倍膨胀），8000 个 `<` 会变成约 32k 字符。

**影响**

AGENTS 写的 `RESULT_CAP = 8000` 只是“正文截断到 8000”，最终工具消息可远超 8000；含大量 `<` 的页面会显著放大上下文，连续读取可能挤爆模型窗口。

**建议**

- 先计算 envelope 的固定开销，再按“最终字符串”预算截断；或让 `untrusted()` 返回 `{ text, truncated }`，由调用方统一 cap。
- 截断标记放在 envelope 内，不要额外增加正文。
- 回归：8000 个 `<` 的页面，最终 `text.length` 必须 ≤ 8000（或明确的新上限）。

## 4. P2：前端体验与性能

### P2-26 流式 Markdown 每 50ms 全量重解析

**证据**

- `App.tsx` 的流式 flush 间隔 50ms；`src/components/MarkdownView.tsx:60-66` 每次 `text` 变化都重新跑 remark + rehype + KaTeX。
- `memo` 只能避免“文本未变”的重渲染，流式时文本每次都变。

**影响**

长回答（尤其是含表格/公式）在生成过程中 CPU 占用高、输入卡顿；复杂度随文本长度近似 O(n²)。

**建议**

- 流式期间用轻量纯文本/增量块渲染，结束后再做一次完整 Markdown；或把 flush 间隔调到 100–150ms 并按“稳定块”缓存。
- 对代码块/公式做未闭合检测，避免每个 token 都触发 KaTeX。

### P2-27 `grabPage` 的全量元素扫描造成布局抖动

**证据**

- `src/lib/extract.ts:54-108` 在页面里对所有元素调用 `getBoundingClientRect` 来收集可见区域文本（最多 600 行/20k 字符）。

**影响**

大 DOM 页面（新闻站、后台系统）每次打开侧栏都会强制同步布局，面板出现明显延迟。

**建议**

- 限制候选元素数量（如 2000），优先用 `IntersectionObserver` 或 `elementsFromPoint` 采样；或只扫描文本块级元素。
- 在 `requestIdleCallback` 中做，避免阻塞首屏。

## 5. P2：工程化与 CI

- **无 ESLint/Prettier**：风格靠人工与 `tsc`；`App.tsx:922` 的双引号、`i18n.ts` 的前导空格这类问题只能靠 review。建议至少加 ESLint（`@typescript-eslint`）与 Prettier check，或明确接受现状。
- **`server/index.mjs` 1441 行、`App.tsx` 1201 行**：路由、SSE、工具循环、设置页逻辑集中在一个文件；后续修改容易碰耦合。建议按“路由/会话/设置/SSE”拆模块，但不必在本轮做。
- **无前端单测**：AGENTS 已承认；至少给 `messages.ts`、`editorDom.ts`、`format` 加纯函数测试，成本低、收益高。
- **构建产物 1.02MB**：`pnpm build` 提示 chunk > 500KB（主要是 React + Markdown + KaTeX）。侧栏本地加载，影响小于网页，但可考虑把 KaTeX 字体/组件按需加载。
- **CI 只有 Windows**：与产品一致，不是问题；但 PowerShell 未解析（P2-19）是明显缺口。
- **`package.json` 没有 `packageManager`**：CI 用 pnpm 11，本地 Corepack 不会自动锁定；建议补 `packageManager` 字段。
- **`.gitignore` 没有 `*.pem`**：AGENTS 说扩展私钥只放 `~/.config`，但仓库根目录若出现 `extension-key.pem` 仍可被提交；建议加一行。
- **CI 没有 `permissions: contents: read`**：默认 token 权限偏大；加最小权限。

## 6. P3：低风险问题清单

| 位置 | 问题 | 建议 |
| --- | --- | --- |
| `server/index.mjs:301` | `body.model?.trim()` 对数字/对象会抛 TypeError；`/api/settings/test` 的 catch 把它变成 200 + “请求失败：...trim is not a function” | 用 `typeof body.model === 'string'` 判断 |
| `server/index.mjs:1414` | `readJson(req, res, ...)` 的 `res` 未使用，且没有 `aborted` 监听 | 去掉参数；请求中断时停止读取 |
| `server/index.mjs:608` | `emit` 引用 `:646` 才声明的 `started`；当前 `meta` 不触碰所以安全，但很脆弱 | 把 `started` 提前声明 |
| `server/index.mjs:866-881` | 未执行的工具调用写入 `toolFailed:false`，历史 UI 可能显示成功 | 增加 `skipped:true` 或 `toolFailed:true` |
| `server/index.mjs:1111-1136` | `saveShot` 没有字节上限 | 加 `MAX_SHOT_BYTES`，超限丢弃并记日志 |
| `server/index.mjs:893-912` | 非 `UpstreamError` 的 SSE `error` 直接带 `err.message`，没有 `code`，且内容可能是内部路径 | 统一 `errorPayload('server.internal')`，细节进日志 |
| `server/index.mjs:291,300,305` | 设置页测试返回中文 `detail`，并把上游响应体前 160 字符/原始 fetch 错误直接给前端 | 返回 `settings.test_failed` + `params`；`raw` 只记日志 |
| `server/settings.mjs:97-100` | 非 ENOENT 的读取失败（锁/权限）返回 `normalize({})`，注释却说“不要用默认值掩盖” | 保留 last-known-good，或返回 503 `settings.unreadable` |
| `server/index.mjs:142-146` | 没有 `server.on('error')`；`run.json` 在 listen 前写入，EADDRINUSE 会留下假“异常退出”标记 | listen 成功后再写 marker；注册 error 处理器并走 clean exit |
| `server/index.mjs:463-475` | 本地 PDF 接受任意绝对 `file:` 路径，没有根目录 allowlist | 限制到用户目录/活动标签路径，拒绝 UNC/设备路径 |
| `server/index.mjs:686-689` | 无状态多轮把每一跳的 `input_tokens` 相加，而每跳都重发完整历史，显示值偏大 | 只统计最后一跳，或标注“累计、含重发” |
| `server/settings.mjs:244-245` | 11–20 字符的 key 会显示首 6 + 末 4，泄露 10 个字符 | 短 key 只显示末 2–4 位 |
| `server/db.mjs:247-287` | 注释声称并发插入安全，但 `doomed` 与 `boundary` 是两条查询；中间插入的行会被误删 | 单进程同步下可接受；修正注释或用同一快照 |
| `server/db.mjs:445-481` | 截图 LRU 把“文件不存在”的 `null` 永久缓存 | 只缓存命中；miss 不缓存或短 TTL |
| `server/db.mjs:527-547` | `statsFor` 返回的 `lastUser`/`lastAnswer` 没有被使用 | 删除或用于标题逻辑 |
| `server/tools.mjs:112-118` | 未知工具不设 `failed:true`，模型会当成成功 | 设 `failed:true`，让熔断计数生效 |
| `server/tools.mjs:123-139` | 截图结果文本没有 `<untrusted_content>` 包裹 | 图片说明是我们的文案，可接受；但统一 envelope 更安全 |
| `server/tools.mjs:370-375` | `cap()` 先截断再 `wrap()`，最终文本超过 8000 字符（含转义膨胀） | 见 P2-25，按“含 envelope”的总预算截断 |
| `server/pdf.mjs:74` | 页面解析失败文案是中文；`renderMarkdown` 插入 `### 第 N 页` 中文标题进模型输入 | 按 locale 输出，或统一英文结构标记 |
| `server/index.mjs:353` | 自动标题持有 `activeChats` 时删除对话返回 409 | 见 P2-1，先减计数再起标题 |
| `src/lib/i18n.ts:68-69` | zh-CN 字典的 `page.failure.blockedRaw` 是英文 | 翻译；并让守卫检查“zh 字典混英文” |
| `src/lib/i18n.ts:29` | `history.count` 值带前导空格，`HistoryPanel.tsx:25` 又加两个空格 | 去掉值内空格，统一由 JSX 排版 |
| `src/entrypoints/sidepanel/App.tsx:858-863` | `handleCopy` 没有 try/catch，剪贴板被拒时 unhandled rejection | catch 后 `showToast` |
| `App.tsx:820-833` | 忙碌时按 Enter 被 `preventDefault` 吞掉，不换行也不发送 | 忙碌时允许换行，或给出提示 |
| `App.tsx:89-99` + `editorDom.ts:16` | `<q>…</q>` 不转义；引文含 `</q>` 会破坏渲染/恢复 | 用属性或转义；至少过滤 `</q>` |
| `App.tsx:272` | 切到不可读页面时中止请求但不清空旧消息 | 清空或显示“当前页面不可读” |
| `App.tsx:570` | 新一轮开始后旧一轮的 `title` 事件被丢弃 | 标题事件按 conversationId 更新，不受 runSeq 影响 |
| `src/entrypoints/background.ts:46-57` | `lastPanelOpen` 写入完整 URL 但从未读取 | 删除调试代码，或脱敏 |
| `src/components/MarkdownView.tsx:15-24` | 相对链接被解析到 `https://pageask.invalid/...` | 相对链接按当前页面 URL 解析，或显示为纯文本 |
| `src/entrypoints/sidepanel/Composer.tsx:61` | 输入框 `aria-label` 是占位句，不是“输入问题” | 用固定标签 |
| `src/entrypoints/sidepanel/main.tsx` | 没有 React error boundary | 加一个，避免单组件异常白屏 |
| `wxt.config.ts:30,45` | manifest 的 `description` / `default_title` 是中文 | 用 `_locales` 或至少接受“浏览器 UI 固定中文” |
| `src/entrypoints/sidepanel/HistoryPanel.tsx` | 历史列表无虚拟化；长列表全部渲染 | 50+ 条后再考虑 |
| `server/extension-id.mjs:26-28` | `Buffer.from(...,'base64')` 会忽略非法字符，只拒绝空 DER | 用严格 base64 校验（长度/字符集） |
| `server/upstream.mjs:4` | `withV1` 只认 `/v1` 结尾，Azure `/openai/deployments/...` 会被拼成 `.../v1/responses` | 明确 Azure baseUrl 约定，或按 host 分支 |
| `scripts/probe-api.mjs:20` | 仍调用 `/chat/completions`，与 AGENTS“禁止回退 Chat Completions”冲突 | 删除或改成 `/responses` |
| `scripts/probe-sw.mjs:48` | 在真实扩展里创建重复 context menu，且无清理、无用户手势调用 `sidePanel.open` | 标记为 debug 工具，移出仓库或加门禁 |
| `scripts/test-turn-integrity.mjs:54` | 名称说“rowid 连续”，实际只断言 `messages.length` 与角色顺序 | 断言 `rowid` 连续，并加回滚用例 |
| `scripts/test-lifecycle-recover.mjs:197` | “已关闭”只断言文件存在 | 检查 DB 可打开/`PRAGMA integrity_check` |
| `scripts/test-settings-webui.mjs:148` | 用整页长度比较 en-XA，聚合断言太弱 | 按 key 比较伪本地化长度 |
| `test/` | 没有 `/pdf` 带 token、自动标题 URL、SSRF 三类绕过、部分失败持久化的回归 | 按 P1/P2 补 4 条 |

## 7. 做得好的地方

- **安全基线**：只监听 `127.0.0.1`；CORS 只允许扩展 ID 与同源设置页；token 比较、`/health/live` 免鉴权、请求体 4MB/64MB 上限、`readBodyCapped` 的流式字节计数，都是有意识的设计。
- **数据一致性**：`addTurn` 用 `BEGIN IMMEDIATE` + SAVEPOINT 把 assistant 与 tool 行写在一个事务里；中止/熔断时给未执行的调用补占位输出；`rowsToItems` 跳过没有 output 的调用，避免上游 400。
- **恢复与生命周期**：`run.json` 心跳、异常退出检测、未回答 user 消息的恢复、`shutdown()` 统一清理，覆盖了桌面端常见的崩溃场景。
- **截图链路**：原子写入、内容哈希命名、孤儿清理、LRU 读取，细节到位。
- **前端状态机**：`sendingRef` 同步门、`runSeq`/`loadSeq` 防串台、50ms 批量 flush、按 `targetId` 分段、工具开始/结束重置目标，都是实际踩坑后的正确修复。
- **可访问性与主题**：大部分图标按钮有 `aria-label`，主题走 CSS 变量，暗色模式完整；Markdown 禁 raw HTML、链接协议白名单、图片不自动加载，安全意识好。
- **i18n 体系**：`satisfies Record<MessageKey, string>` 保证两份字典键对齐；错误码 `domain.reason` + `tError` 的契约清楚；en-XA 伪本地化用于布局测试，是成熟做法。
- **测试**：7 个后端回归使用临时 HOME/data + fake upstream，不碰真实配置；`test-turn-integrity` / `test-turn-abort` / `test-empty-stream` 覆盖了最容易回归的协议边界。

## 8. 验证记录

在 `b9533d3` 上执行：

| 命令 | 结果 |
| --- | --- |
| `node scripts/check-i18n.mjs` | 通过 |
| `node scripts/check-syntax.mjs` | 通过（42 个 `.mjs`） |
| `pnpm compile`（`tsc --noEmit` + 语法） | 通过 |
| `pnpm test:server`（7 个脚本） | 全部通过 |
| `pnpm build` | 通过；提示 sidepanel chunk 1.02MB > 500KB |
| `pnpm verify` | 未作为单条命令执行；上述各步均已分别通过 |

未执行：真实 Edge 面板手工测试、真实上游联调、负载/长对话测试、托盘交互测试。因此本报告对运行时 UI 的判断以代码为准，不替代手工验收。

## 9. 建议修复顺序

**第 1 批（P1，建议本次迭代内完成）**

1. PDF 请求带 token + 回归（P1-1）。
2. 上游失败时持久化已流式正文（P1-2）。
3. SSRF：重定向手动跟随 + 每跳校验、IPv4-mapped IPv6 数值解析、hostname DNS 解析（P1-3）。

**第 2 批（P2，按用户可见度排序）**

1. 自动标题 URL、异步化、超时（P2-1）。
2. `state=off` 显式 `store:false`；截断流标记 `incomplete`（P2-21/P2-22）。
3. 同对话 `/chat`、`DELETE` 互斥（P2-23）。
4. 英文回答 / 系统提示 locale（P2-3）。
5. 后端 i18n + 守卫扫描范围（P2-5）。
6. `regenerate` 输入框状态（P2-12）。
7. 有状态回退（P2-2）。
8. Host 校验/rebinding、顶层 500 契约、工具 envelope 上限（P2-6/P2-24/P2-25）。
9. 托盘 token 探测、BOM、watchdog 阻塞（P2-15~17）。
10. SSE CRLF、PDF 上限、历史分页（P2-8~10）。

**第 3 批（P3，随手修）**

- 表格中的低风险项；优先 `handleCopy`、Enter 行为、`<q>` 转义、`i18n.ts` 两处文案、`test-chat` 头。
- 补 `settings.mjs` 读取失败、EADDRINUSE 标记、本地 PDF allowlist、`totals` 统计、`maskKey`。
- 引入 ESLint/Prettier 或至少 `eslint --max-warnings=0` 的 CI 步骤；补 PowerShell 解析。

## 10. 总体评价

代码的“骨架”是可靠的：安全边界、事务、恢复、错误码、i18n 字典、回归脚本都说明作者理解这个产品的失败模式。当前问题更多是**长尾一致性**：新增的 token 没有覆盖 PDF，新增的自动标题没有复用 `withV1`，新增的英文界面没有覆盖后端提示，新增的重定向没有复用 SSRF 校验。它们不是架构性错误，但都会在特定配置下直接破坏主路径。

建议保持现有设计，不做大拆大改；先把 3 个 P1 和“自动标题 / 英文回答 / 后端 i18n / 重生成输入框 / 截断持久化”这几条用户可见的 P2 修掉，再补对应回归。这样这一版可以从 6.5 提升到 8 分左右，而不增加系统复杂度。

## 11. 修复记录（2026-11-08）

本节记录审查之后的改动；上面的正文仍是 `b9533d3` 的审查基线，不随修复改写。

### P1-3 SSRF

- `server/net.mjs`：重定向改为手动跟随（最多 5 跳），每一跳重新校验；IPv4/IPv6 改为数值解析，覆盖短写、数字、十六进制、八进制、IPv4-mapped/NAT64/6to4；域名用 `dns.lookup({ all: true })` 解析，任一地址为私网即拒绝，DNS 失败关闭。
- `server/tools.mjs`、`server/index.mjs`：`fetchPdf` 与 `downloadPdf` 统一走新的 `fetchPublic()`，不再使用 `redirect: 'follow'`。
- `scripts/test-ssrf.mjs`：覆盖上述地址形式、私网 DNS、混合 DNS、重定向到回环/私网 DNS、相对重定向、重定向上限。
- 验证：`pnpm verify` 通过（8 个后端回归；43 个 `.mjs` 语法检查）。
- 残留：DNS 解析与连接之间仍有理论上存在的 rebinding TOCTOU，已在 `server/net.mjs` 头部注释说明；彻底消除需要把解析结果固定到连接层。

### P1-1 PDF 鉴权

- `readActiveTab` 现在接收 `token`，`App.tsx` 用 ref 保存后端 URL 与 token；设置加载完成后再读取当前页，避免首次以空 token 读取 PDF。
- `readPdfFromTab` / `readLocalPdf` 的两个 `/pdf` 请求都带 `Authorization: Bearer <token>`；未配置 token 时不发该头。
- `scripts/test-pdf-auth.mjs`：临时后端配置 token，断言无 token/错误 token 为 401（`auth.bad_token`），正确 token 能解析 `test/marker.pdf` 并返回正文。
- 验证：`pnpm verify` 通过（9 个后端回归；44 个 `.mjs` 语法检查）。

### P1-2 上游失败时的半截正文

- `streamTurn` 在抛出 `UpstreamError` 前把已流出的 `content` / `reasoning` / `usage` 挂到 `err.partial`；`err.streamed` 仍用于禁止重试。
- `handleChat` 的 catch 在非用户中止、已写入用户消息且存在半截内容时，调用同一个 `addTurn()` 事务写一条 `aborted: true` 的 assistant 行，再发 SSE `error`；二次写库失败只记 `chat_partial_persist_failed`，不掩盖原始上游错误。
- `scripts/test-partial-failure.mjs`：fake upstream 先发 `response.output_text.delta`，再发 `response.failed`；断言 SSE 有正文和 error、没有 done，历史中恰好一条 assistant 行、正文一致且 `aborted` 为 true。
- 验证：`pnpm verify` 通过（10 个后端回归；45 个 `.mjs` 语法检查），构建仅有既有的 sidepanel 1.02MB chunk 警告。

### P2-1 / P2-2 / P2-21 / P2-22 / P2-23 回合引擎

- **P2-1 自动标题**：URL 改为 `${withV1(cfg.baseUrl)}/responses`，请求体固定 `store:false`，超时从 20s 降到 8s；`handleChat` 在 `await autoTitle()` 之前调用幂等的 `releaseChat()`，删除对话不再被标题请求阻塞。
- **P2-2 有状态回退**：任意链式 4xx（400/404/409/422）都会把 `statefulUnsupported` 置为 true，本进程不再尝试 `previous_response_id`；回退请求不带 `store`，其响应 id 不会成为新 anchor。无 id 但有 tool_calls 的分支在重建历史后追加当前 `turn.items`，避免 `function_call_output` 找不到 `function_call`。代价是一次坏链会在进程内全局关闭有状态模式，重启后恢复。
- **P2-21**：`streamTurn` 显式 `body.store = Boolean(store || previousResponseId)`，`state=off` 时不再依赖上游默认的 `store=true`。
- **P2-22**：流在若干 delta 后正常关闭、但没有 `response.completed` 且已有正文时，标记 `incomplete`；该轮按 `aborted` 落库，`done` 带 `aborted:true`，不再生成标题。真正的 `response.incomplete` 仍单独映射。
- **P2-23**：`/chat` 在写 user 行之前检查同一 `conversationId` 的 `activeChats`，已有则返回 409 `conversation.busy`；`DELETE /conversations/:id` 同样返回 409。`releaseChat()` 幂等，正常完成与 `finally` 都可调用。
- **回归**：`scripts/test-auto-title.mjs`（/v1 路径、answer/title 的 `store:false`、SSE title 与落库）、`scripts/test-truncated-stream.mjs`（无 completed 的 EOF → aborted、不生成标题）、`scripts/test-chat-busy.mjs`（并发 `/chat` 与流式期间 DELETE 均 409）、`scripts/test-stateful-fallback.mjs`（链式 400 → 无状态成功 → 第三轮不再带 anchor）。
- 验证：`pnpm verify` 通过（14 个后端回归；49 个 `.mjs` 语法检查），构建仅既有 sidepanel 1.02MB chunk 警告。

### P2-4 / P2-6 / P2-24 / P2-25 安全边界与错误契约

- **P2-6 Host / rebinding**：`server/index.mjs` 新增 `isAllowedHost()`，只接受 `127.0.0.1:${PORT}`、`localhost:${PORT}`（80 端口时为裸主机名）；`handle()` 最前面校验，其余一律 403 `request.bad_host`。这挡住了把自定义域名解析到回环的 rebinding 页面，同时保留本机脚本与设置页的访问方式。
- **P2-4 页面元数据**：`buildSystemPrompt()` 不再把标题/URL 拼进“当前页面/网址”这类可信指令行，而是放入 `<untrusted_content source="page-metadata">` 信封，标题和 URL 都经过 `escapeUntrusted()`；提示明确说明这两行只是数据。标题里的 `</untrusted_content>` 不再能提前闭合信封。
- **P2-24 错误契约**：`decodeURIComponent` 包进 `decodeConversationId()`，畸形 `%` 返回 400 `request.bad_id`（`/conversations/:id` 与 `/recover`）；顶层 catch 改为 `logError('unhandled_request')` + `errorPayload('server.internal')`，只回错误码不回 `err.message`；`/api/settings/test` 的 `model` 先做 `typeof === 'string'` 判断，数字/对象不再触发 500。
- **P2-25 工具上限**：`untrusted()` 改为对“含 envelope 的最终字符串”执行 `RESULT_CAP` 预算，属性截到 600 字符，正文过长时在信封内追加截断说明；关闭标签仍只在末尾出现，最终 `text.length <= 8000`。`read_page` 等调用点不再各自先 `cap()` 再 `wrap()`。
- **文案**：新增 `error.request.bad_host`、`error.request.bad_id`、`error.server.internal`，四个字典（server zh-CN/en-US、src zh-CN/en-US）同步，en-XA 由前缀规则自动覆盖。
- **回归**：`scripts/test-host.mjs`（陌生 Host 403、回环 Host 200、畸形 id 400）、`scripts/test-page-metadata.mjs`（恶意标题被转义、信封不提前闭合）、`scripts/test-tool-cap.mjs`（最终长度 ≤ 8000、截断标记在信封内）。
- 验证：`pnpm verify` 通过（17 个后端回归；52 个 `.mjs` 语法检查），构建仅既有 sidepanel 1.03MB chunk 警告。

### P2-3 / P2-5 国际化收尾

- **请求 locale**：`ChatRequest` 增加 `locale`，`App.tsx` 发送 `getLocale()`；后端把未知值收敛为 `zh-CN`。
- **系统提示**：`buildSystemPrompt(page, locale)` 改为一份英文提示，仅在结尾切换 `Answer in English.` / `Answer in Simplified Chinese.`；页面标题、URL 仍在 `<untrusted_content source="page-metadata">` 内。自动标题提示同样改为英文，并按 locale 指定标题语言；`cleanTitle` 只识别 `Title:`（中文前缀写成 `\u6807\u9898` 转义，避免成为硬编码文案）。
- **工具与错误文案**：删除 `TOOL_LABELS`，改为服务端字典的 `tool.*` 与 `tool.detail.*` / `tool.*Body`；工具中止、超时、失败、熔断、未执行、`chat.stopped` 都按 locale 输出。PDF、网络、`fetch_url` 拒绝等面向用户的文案统一改为英文；其 UI 展示仍由错误码映射。
- **设置页测试连接**：不再回传上游响应体或 `err.message`；未配置 Key 返回 `settings.missing_api_key`，HTTP 失败返回 `upstream.status`，请求异常返回 `settings.test_failed`，设置页用字典渲染。
- **i18n 守卫**：`check-i18n.mjs` 的扫描范围扩展到 `server/**/*.mjs`（排除 `server/i18n/`）与 `wxt.config.ts`；中文注释/日志仍豁免。为此把 `server/db.mjs` 的中文 SQL 注释也改成了英文。
- **manifest**：`wxt.config.ts` 设置 `default_locale: 'zh_CN'`，描述与 action 标题改用 `__MSG_*__`；新增 `public/_locales/zh_CN/messages.json` 与 `public/_locales/en/messages.json`，构建产物包含 `_locales/`。
- **回归**：`scripts/test-i18n-chat.mjs` 用 fake upstream 抓取两种 locale 的回答/标题请求，断言语言指令、提示中无 CJK、页面元数据信封存在；`test-empty-stream.mjs` 与 `test-page-metadata.mjs` 的旧中文断言同步更新。
- 验证：`pnpm verify` 通过（18 个后端回归；53 个 `.mjs` 语法检查），构建仅既有 sidepanel 1.03MB chunk 警告；检查了构建后的 manifest 与 `_locales`。
- 残留：`errorPayload()` 的兜底文案仍默认 zh-CN；前端与设置页都按 `code` 映射，因此 UI 不受影响，但直接调用 API 的脚本在不带 locale 时可能看到中文兜底。


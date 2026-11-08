# AGENTS.md

给在本仓库工作的 AI 协作者（以及人类）的项目说明。**先读完这一页再动代码**；文档入口见第 9 节。

## 1. 这是什么

PageAsk：Edge 侧栏扩展 + 本机 Node 后端。侧栏就**当前标签页**（网页 / PDF）向 OpenAI 兼容的 `/responses` 接口提问。

- 扩展：WXT 0.21 + React 19 + TypeScript（strict），`src/`。
- 后端：`node server/index.mjs`，只监听 `127.0.0.1:8787`，路由/存储全部用 Node 内置模块（`node:http`、`node:sqlite`）；只有 PDF 解析用第三方 `pdfjs-dist`（legacy build）。
- API Key 只存在后端 `~/.config/pageask/settings.json`，浏览器侧任何时候都不持有 Key。
- 刻意只支持自用、不上架；`host_permissions: ['<all_urls>']` 是有意为之（见 `wxt.config.ts` 注释）。

## 2. 环境与命令

| 命令 | 作用 |
| --- | --- |
| `pnpm install` | 安装（`postinstall` 会跑 `wxt prepare`） |
| `pnpm dev:edge` | WXT dev + 拉起 Edge（`wxt -b edge`） |
| `pnpm build` | 生产构建 → `.output/chrome-mv3` |
| `pnpm compile` | `tsc --noEmit` + `scripts/check-syntax.mjs`（后端/脚本 `.mjs` 语法），**改完必须过** |
| `pnpm test:server` | 串跑 `scripts/test-*.mjs` 后端回归（临时目录 + 假上游，不碰真实配置） |
| `pnpm verify` | `check:i18n` + `compile` + `test:server` + `build`，提交前跑这个 |
| `pnpm server` | 前台起后端（`node server/index.mjs`） |
| `pnpm server:win` | 用 PowerShell 脚本起后端 |
| `pnpm tray:bg` | WinForms 托盘 + 看门狗，后台常驻 |

- 托盘只按 `/health/live` 判断后端；端口被别的程序占用时显示「端口被占用」并暂停自动重启；退出托盘只停自己拉起的后端（外部 `pnpm server` 不动）。

- Node **≥ 22.13**（`node:sqlite` + pdfjs-dist 6.x），包管理器用 pnpm（11.x）。
- 有 git 仓库与 GitHub Actions（`.github/workflows/ci.yml`，windows-latest + Node 22.13 + `pnpm verify`）；远端为 `origin`（GitHub），push/PR 时触发，Dependabot 每周提依赖更新 PR。
- 改扩展代码后要在 `edge://extensions` 点「重新加载」；改后端要重启进程；只改 `~/.config/pageask/settings.json` 不用重启（后端每次请求都重读）。
- 版本号只在 `package.json` 维护，`wxt.config.ts` 通过 JSON import 读取；别再手写第二份。

## 3. 目录

```
src/entrypoints/background.ts     service worker：sidePanel 行为、右键菜单
src/entrypoints/sidepanel/        侧栏：App.tsx 编排状态机；messages.ts 纯消息模型，
                                  editorDom.ts contenteditable 适配，Composer/HistoryPanel/
                                  PageCard/RoundPanel/SettingsPanel 为展示组件
src/lib/                          chat.ts / extract.ts / pdf.ts / settings.ts / i18n.ts / i18n.en-US.ts
src/components/                   MarkdownView.tsx、icons.tsx
server/                           后端：index.mjs 路由 + db/tools/pdf/text/log/webui/net/lifecycle
server/i18n/                      后端文案字典（zh-CN.mjs + en-US.mjs + en-XA 伪本地化）与 t()/negotiateLocale()
server/data/                      运行时产物（db、shots/、日志、run.json），不要提交
scripts/                          PowerShell 启动/托盘/测试实例 + CDP/冒烟脚本
test/                             手测夹具（article.html、*.pdf）
docs/prior-art.md                 竞品调研；docs/img/ 版本截图
PLAN.md                           已归档的早期规划（不再维护，勿作实现依据）
```

## 4. 数据流（改任何一端前先看懂）

1. 侧栏启动 → `readActiveTab()`：普通网页用 `scripting.executeScript` 注入 `grabPage()`，再用 Defuddle 抽正文；PDF 由扩展带 cookie 取字节后 `POST /pdf` 交给后端解析；`edge://`、扩展商店等受限页直接报「读不到这个页面」。
2. 用户发送 → 扩展重新取选区 + 截当前可见画面 → `POST /chat`（SSE 流）。
3. 后端**不把正文塞进 system prompt**：只传页面元信息/选区，正文由模型按需调工具读取：`read_page`、`screenshot`、`web_search`、`fetch_url`。
4. 工具循环没有步数上限，只有用户点「停止」（`AbortController`）才结束；每段 assistant 与工具结果都落 SQLite。
5. SSE 事件：`meta`、`reasoning`、`content`、`usage`、`tool`、`done`、`error`、`title`。前端 `src/lib/chat.ts` 的 `streamChat()` 手工读 `res.body` 解析。
6. 进程异常退出：后端启动写 `server/data/run.json`（30s 心跳），正常退出删除；下次启动 `/health.lifecycle.abnormalPreviousExit` 为真，托盘会提醒。若崩溃时最后一条是没回答的 user，侧栏读取会话时调 `POST /conversations/:id/recover` 把它取回输入框并从库里删除（输入框已有草稿时不覆盖，留到下次）。

## 5. 硬约束（违反会直接坏）

**安全 / 网络**
- 后端只绑定 `127.0.0.1`，绝不改 `0.0.0.0`。
- CORS：无 Origin（curl/脚本）、同源 `127.0.0.1:8787`/`localhost:8787`、`chrome-extension://${PAGEASK_EXTENSION_ID}` 之外一律 403。
- `/settings` 与 `/api/settings*` 在 token 校验**之前**（配置页要能自救）；但 `/api/settings*` 只接受同源请求或带正确 token 的请求。`GET /health/live` 无鉴权，只回报存活信息。
- Key 不进扩展、不进前端 `chrome.storage`、不写日志、不回传明文（配置页只显示 `sk-554…f398`）。
- 模型/网页来源的 URL 出站前过 `server/net.mjs`：只允许公网 `http(s)`，本机/内网/云元数据地址直接拒绝；读取按 `content-length` + 流式累计限长，别退回 `arrayBuffer()` 再检查。

**扩展**
- `grabPage()` 会被 `scripting.executeScript({func})` 序列化后注入页面：**必须完全自包含**，不能 import、不能引用模块作用域变量、不能用外部工具函数。
- 打开侧栏交给 `setPanelBehavior({ openPanelOnActionClick: true })`；`contextMenus.onClicked` 里**第一个 await 之前**就要调 `sidePanel.open()`，否则用户手势失效（报 `may only be called in response to a user gesture`）。
- 所有面向用户的文案集中在 `src/lib/i18n.ts` 与 `src/lib/i18n.en-US.ts`（`t('模块.名字')`）；两份字典 key 必须一致（`satisfies Record<MessageKey, string>` 由 `tsc` 保证），组件里不写硬编码中文 UI 文案。
- 界面语言存 `settings.locale`（`auto` / `zh-CN` / `en-US`，默认 `auto` 跟随浏览器）；`resolveLocale()` 把 `auto` 解析成具体 locale，切换后要 `setLocale()` 再触发重渲染，并同步 `<html lang>`。
- 主题只改 `style.css` 的 CSS 变量（`:root` + `prefers-color-scheme: dark`），不写死颜色。
- 存储键是 `pageask.settings.v2`；`backendUrl` 去尾斜杠；会话键用去 `#hash` 的 URL。
- `App.tsx` 里的同步闸门 `sendingRef`、流式 token 50ms 批量 setState、contenteditable 引用 chip（序列化为 `<q>…</q>`）都是修过的坑，别简化掉。

**后端**
- `server/settings.mjs` 是模型配置的唯一真源；每次调用重读文件；`writeSettings` 里 `apiKey === ''` 表示「不修改」；**不读模型相关的环境变量**（避免「改了文件没生效」）。环境变量只决定服务怎么起来：`PAGEASK_PORT`、`PAGEASK_EXTENSION_ID`、`PAGEASK_TOKEN`、`PAGEASK_DATA_DIR`。
- 工具结果必须包 `<untrusted_content source=...>` 并硬截断（`RESULT_CAP = 8000`）；工具失败只给模型一句中文原因，细节走 `logError`，不要把上游报文透给前端。
- 退出必须走 `shutdown()`（`SIGINT/SIGTERM/SIGBREAK` 与 `POST /api/shutdown`）：删 `run.json`、关连接、`closeDb()`；不要直接 `process.exit` 跳过，否则 WAL 不 checkpoint 且下次误报异常退出。
- `addTurn()` 用一个事务同时写 assistant 与 tool 行；工具循环提前结束时必须给未执行的 call 补 `<untrusted_content>` 占位 output，`rowsToItems` 回放时跳过没有 output 的 call，避免上游 400。
- 数据库加列用 `PRAGMA table_info` + `ALTER TABLE` 就地补，不写破坏性迁移；`messages.role` 只有 `user | assistant | tool`。
- 改协议必须两端同步：`server/index.mjs` 的 SSE emit ↔ `src/lib/chat.ts` 的 `ChatEvent`；`page` 字段 ↔ `ChatRequest`。
- 错误契约：HTTP 4xx/5xx 与 SSE `error` 都走 `server/errors.mjs` 的 `errorPayload()` / `UpstreamError`，响应体至少含 `code`（`domain.reason`）与可选 `params`，`message` 只作 fallback；前端用 `tError(code, params, message)` 映射 `error.<code>`。新增错误先定 code，再补两端文案；测试断言 `code`，不要断言中文句子。
- 后端面向用户的文案（配置页、错误 fallback）统一放在 `server/i18n/zh-CN.mjs` 与 `server/i18n/en-US.mjs`：配置页用 `t('webui.*')`，错误用 `error.<code>`；`server/webui.mjs` 里不写硬编码中文。配置页按 `?lang=` / `Accept-Language` 选字典，页内语言下拉会带 `?lang=` 重载；现有 `zh-CN`、`en-US` 与伪本地化 `en-XA`（只用于布局测试，不是真实语言），不认识的语言回退默认；新增 locale 只加字典文件与 `server/i18n/index.mjs` 的注册，客户端脚本会拿到整份字典。
- 托盘文案在 `scripts/i18n/<culture>/Tray.psd1`，`scripts/tray.ps1` 与 `scripts/tray-bg.ps1` 用 `Import-LocalizedData` 按 `$PSUICulture` 加载；先试完整 culture，再试语言前缀，最后回退 `en-US` / `zh-CN`。脚本里不写用户可见中文（`Write-Tray` 日志保持英文）。
- `scripts/check-i18n.mjs` 是本地化守护，已串进 `pnpm verify`：扫 UI 字符串字面量里的硬编码中文（注释与 `[pageask]` 日志除外）、校验 server/client 错误码覆盖、zh-CN/en-US/en-XA 的 key 对齐与伪本地化长度、托盘两份字典与 `$script:Tray.*` 双向一致。
- 关键上限：`MAX_OUTPUT_TOKENS = 8192`、上游超时 300s、请求体 4MB（`/pdf` 64MB）、PDF 400 页 / 40 万字符。
- 上游走 Responses API。`state=auto` 只对已知端点（`api.openai.com`、`*.openai.azure.com`、`*.services.ai.azure.com`）启用 `previous_response_id`；链断按 400/404/409/422 结构性判定并整段回退，失败后本进程不再尝试。不要改回 Chat Completions，也不要回传 reasoning item。

## 6. 代码风格

- 2 空格缩进、单引号、分号、尾逗号；行宽约 120。
- 注释用中文，**解释为什么**（踩过的坑、协议限制、取舍），不写「这里做了什么」的废话。
- 导出的类型/接口写在 `src/lib/*.ts`，组件只消费；避免 `any`，`tsconfig` 开了 `strict` 与 `noUncheckedIndexedAccess`。
- 新增依赖前先想清楚：后端 HTTP/DB 层应保持零依赖；PDF 只在 `server/pdf.mjs` 用 `pdfjs-dist`。

## 7. 验证方式

提交前先跑 `pnpm verify`（本地化守护 + 类型 + 37 个 `.mjs` 语法 + 6 个后端回归 + 构建）；CI 用同一命令。仍没有前端单测，UI 靠类型检查 + 手测：

1. `pnpm verify` 通过；只改前端时至少 `pnpm compile` + `pnpm build`。
2. 后端改动：`pnpm server` 起服务，`curl http://127.0.0.1:8787/health`；必要时 `node scripts/test-chat.mjs "问题"` 看 SSE 事件；新增行为优先补进 `scripts/test-*.mjs`（临时 `PAGEASK_DATA_DIR`/`USERPROFILE` + 假上游，不要碰真实配置）。
3. UI 改动：`pnpm build` → `pwsh -File scripts/edge-test.ps1`（干净 Edge + CDP，默认打开 `127.0.0.1:8811/article.html`，需要自己先把 `test/` 静态服务在 8811 端口）；用 `scripts/cdp-eval.mjs`、`cdp-key.mjs`、`cdp-dark.mjs` 检查侧栏与深浅色。
4. 专项脚本：`test-cache.mjs`（前缀缓存）、`test-shot.mjs`（截图落盘/回放）、`test-pdf-prompt.mjs`、`test-selection-context.mjs`、`test-hist-time.mjs`、`test-turn-integrity.mjs` / `test-turn-abort.mjs`（工具轮次与中止）、`test-empty-stream.mjs`（空流）、`test-incomplete-and-bad-body.mjs`（截断/坏请求）、`test-lifecycle-recover.mjs`（异常退出/断尾提问恢复）、`test-settings-webui.mjs`（配置页文案/错误码/清空 Key/token 同源）。
5. 有新决策或踩坑，写进 `docs/` 或提交说明；`PLAN.md` 已归档，不要再回填。

## 8. 不要再走的路（已实测否掉）

- 快捷键唤起侧栏（Alt+Shift 被系统/输入法占用）；只靠 `activeTab`；在 service worker 里直接 `sidePanel.open()`（早年记录在已归档的 `PLAN.md` §9.4）。
- 把整篇正文拼进 system prompt（P3 已改为工具按需读取）。
- 试图修复「切标签侧栏消失」——Edge 已知缺陷（microsoft/MicrosoftEdge-Extensions#142）。
- 用环境变量覆盖模型配置（与 `settings.mjs` 的设计直接冲突）。
- 自动总结页面：只有用户点发送才请求模型。

## 9. 文档分工

- `README.md`：安装、配置、使用、常见问题（面向用户）。
- `PLAN.md`：早期规划与踩坑记录，**已归档，不再维护，不作为实现依据**；新决策写 `docs/` 或提交说明。
- `docs/prior-art.md`：竞品与技术路线调研。
- 本文件：给协作者的规则摘要；与源码冲突时以源码为准，并顺手修正本文件。

# PageAsk 代码质量审查报告

- 审查日期：2026-11-07
- 审查范围：仓库内全部手写代码（扩展 `src/`、后端 `server/`、脚本 `scripts/`、样式与配置），约 7.9k 行；不含 `node_modules`、构建产物与测试夹具
- 审查方式：逐文件只读通读 + 三路并行子审查（扩展前端 / 后端 / 脚本与工程化）+ 协议两端交叉核对
- 约束：审查期间**未修改任何源码**；未启动后端、Edge 与托盘；未做动态渗透与依赖 CVE 扫描
- 结论先行：**这是一份工程质量明显高于个人项目平均线的自用工具，但“工具轮次落库的一致性”“异步生命周期收尾”和“验证链条”是三块真正的短板**

> **修复状态（2026-11-07，审查后）**：P0-1（工具轮次悬空 `function_call`）与 P1-8（中止/超时丢已生成正文）已修复。
> - `server/db.mjs`：新增 `addTurn()`，assistant 与 tool 行在同一事务写入；`rowsToItems()` 回放时跳过没有对应 output 的 call。
> - `server/index.mjs`：工具结果先攒后写，中止时给未执行的 call 补占位 output；`streamTurn()` 把停止/300s 超时转成部分结果，落库并标记 `aborted`。
> - 验证：`scripts/test-turn-integrity.mjs`、`scripts/test-turn-abort.mjs` 共 8 项断言全部通过；`node --check` 通过。
> - 下文仍保留审查时的原始描述与行号，作为问题记录；修复后的行为以上述说明为准。

> **第二轮修复（2026-11-07，P1 剩余项）**：P1-1～P1-7、P1-9、P1-10 已处理。
> - P1-4/P1-3：新增根 `.gitignore`；`scripts/seed-settings.mjs` 只写 `settings.v2` 的 `{backendUrl,verbose}` 并删除 v1，不再写明文 Key。
> - P1-7：`server/settings.mjs` 解析失败先备份为 `settings.json.broken-*`，不再用默认值覆盖；目录/文件写为 0700/0600（Windows 上 chmod 尽力而为）。
> - P1-10：上游 200 但正文/思考/工具全空时返回 502，不再静默落空回答；配套 `scripts/test-empty-stream.mjs`。
> - P1-9：新增 `server/net.mjs`，`fetch_url`/PDF 下载拒绝本机/内网地址，读取按 content-length + 流式累计双重限长；工具 HTTP 请求加 30s 超时。
> - P1-5/P1-6：扩展设置新增可选访问令牌并随请求发 `Authorization`；`/api/settings*` 要求正确 token 或同源；新增无鉴权 `GET /health/live` 供托盘探活，配置页 CSP 加 `frame-ancestors 'none'`。
> - P1-1：客户端收到 `done` 即释放 `busy`，`finally` 按 `runSeq` 只清理最新一轮；未收到 `done` 的断流按「连接中断」收尾，响应头前停止不再留空气泡。
> - P1-2：托盘探活改问 `/health/live`（失败再退回 TCP）；按端口兜底杀进程前校验 `node.exe` + `server\index.mjs` 命令行。
> - 验证：`node --check`、`pnpm compile`、`pnpm build` 通过；`test-turn-integrity`、`test-turn-abort`、`test-empty-stream` 共 12 项断言通过；curl 验证 `/health/live` 200、`/health` 401、`/api/settings` 无 Origin 403 / 同源 200；`tray.ps1` 解析通过。P1-1 与托盘行为未在真实 Edge/托盘里点过。

---

## 一、总体评价

### 1.1 做得好的地方

**架构决策清楚，且记录在案。** 正文不塞 system prompt、改由模型调用 `read_page`；工具结果统一包 `<untrusted_content>` 并尝试硬截断 8000 字（边界仍有缺口，见 B14）；Key 只存在后端 `~/.config/pageask/settings.json`，浏览器侧不落 Key；`state=auto` 只对官方端点启用有状态链，其余保守走无状态，避免“收下但忽略 `previous_response_id`”的静默失忆。这些都是踩过坑之后收敛出来的选择，`PLAN.md` 里能查到“为什么”。

**安全基本面干净。** Markdown 没有启用 `rehype-raw`，原始 HTML 被当文本丢弃；外链带 `rel="noreferrer noopener"`；KaTeX 走 `renderToStaticMarkup`，没有 `dangerouslySetInnerHTML` 注入面；后端只绑 `127.0.0.1`，CORS 只放行扩展 ID 与同源；配置页用 `textContent` 填值；日志里 `sk-`、`Bearer`、`apiKey` 命中为 0，`settings.saved` 只记 `hasKey`。

**若干实现细节确实到位。** `grabPage()` 与 `readSelection()` 的注入函数真正做到了零外部引用（很多扩展在这里翻车）；选区上下文窗口的省略号偏移计算正确；引用 chip 用 `contentEditable=false` + `data-quote` 序列化；流式 token 50ms 批量、`sendingRef` 同步闸门防连点、贴底滚动用 `ResizeObserver` 补高；`load()` 用 `seq` 丢弃过期结果。这些都不是“能跑就行”的写法。

**文档密度高于同类项目。** `PLAN.md` 记录了 50 个小节的决策与实测结论，`AGENTS.md` 把硬约束、数据流、别再走的路都写清楚了；lockfile 与依赖声明一致，四个 PowerShell 脚本是 UTF-8 BOM（5.1 下中文不乱码）。

### 1.2 评分（10 分制，自用工具的标尺）

| 维度 | 分数 | 说明 |
|---|---:|---|
| 架构与设计 | 8.0 | 职责划分、协议设计、状态链回退都合理；`App.tsx` 与 `index.mjs` 单体偏大 |
| 功能正确性 | 6.0 | 主流程可用；生命周期收尾、页面/会话归属、并发竞态、工具轮次落库有真实缺陷 |
| 安全性 | 7.0 | 注入面与 Key 管理干净；`backendUrl` 无校验、配置端点无鉴权、`fetch_url` 可打内网、明文 Key 落浏览器是减分项 |
| 性能 | 6.5 | 大页面抽取与每次击键全量重渲染是主要瓶颈；流式本身节流做对了 |
| 可维护性 | 6.0 | 命名与注释好；双源常量、死代码、`App.tsx` 五合一 |
| 工程化 | 4.0 | 无 lint / format / test / CI / `.gitignore`；`pnpm compile` 不覆盖后端与脚本 |
| 文档一致性 | 6.5 | 文档多但漂移：零依赖、环境变量、配置路径、版本号四处冲突 |
| **加权总体** | **6.3** | 自用够用，但 P0 的工具轮次一致性说明“能跑”与“可靠”之间还有一层 |

### 1.3 问题统计

| 等级 | 数量 | 含义 |
|---|---:|---|
| P0 | 1 | 会让会话历史永久损坏，必须先修 |
| P1 | 10 | 会导致界面卡死、数据/隐私风险或违反硬约束，建议本轮修复 |
| P2 | 45 | 明显体验缺陷、健壮性缺口、工程化欠账，按批次修 |
| P3 | 39 | 整洁度、可访问性、文案与边角，随手修 |

> 说明：P0 只有一条，但它不是“更严重的 P1”，而是性质不同——悬空的 `function_call` 一旦写进历史，后续每一轮都会带着残缺上下文，连回退到无状态都救不回来。P1 的 10 条里，前 4 条来自前端/脚本，后 6 条来自后端第二轮复核；P2 中有若干条（如 `busy` 滞留、切页串会话）在用户感知上接近 P1，只是有自愈路径或触发条件更窄。

### 1.3.1 修复进度

| 批次 | 提交 | 内容 | 验证 |
|---|---|---|---|
| 初始 | `013ab05` | P0-1、P1-1..P1-10、崩溃恢复（`run.json`/`/api/shutdown`/断尾提问恢复） | 回归脚本 10 + 12 项，compile/build |
| 第一批 P2 | `0676c5e` | F2–F5（切页/改设置不再串会话，历史加载序号与失败横幅） | compile，4 个回归脚本 |
| 第二批 P2 | `138a3f0` | F6/F7/F9/F11/F13/F14/F15/F16/F17、B1/B3/B7 | compile/build，`test-incomplete-and-bad-body` 10 项 |
| 第三批 P2 | `7ce466f` | B4/B11/B12/B14/B16/B17/B19（工具超时与熔断、回退策略、提示词隔离、`/v1` 统一、短 Key 掩码） | 4 个回归脚本全过 |
| 工程化批 | `a6af2ca` | F18、E1（`compile` 串 `.mjs` 语法检查）、E2（Node ≥22.13）、E4（README 依赖/版本）、E5（PLAN 历史横幅）、E6（版本单一来源） | `check:server` 30 个 `.mjs`、compile/build |
| 后续 | — | 其余 P2/P3（见第三、四节） | 每批更新 |

> 表里的提交只是“已修”的记录；正文行号仍是**审查时**的位置，已在后续修复中漂移，定位请以当前代码为准。

### 1.4 最该先修的 9 件事

1. **修 P0-1：回合结束时一次性事务写入 assistant + tool 行，中止时为未执行的 call 补 `function_call_output`**，别让会话历史永久缺一条输出。
2. **流式收尾兜底**：停止/异常断流后把 `streaming` 清干净，别让气泡永久“正在思考”（P1-1）。
3. **托盘停止/重启只杀自己拉起的 node**，不要按端口无差别 `Stop-Process -Force`（P1-2）。
4. **删掉 `seed-settings.mjs` 里写 v1 存储与明文 Key 的逻辑**，Key 永远只进后端（P1-3）。
5. **补 `.gitignore`**，把 `server/data`、`.output`、`.npm-cache`、`.edge-profile*` 挡在版本控制外（P1-4）。
6. **`done` 时释放 `busy`**，或把 `autoTitle` 移出 SSE 连接生命周期（F1）。
7. **统一输入框高度常量**（168 vs 156），修掉第 7 行被裁（F6）。
8. **给 `MarkdownView` 加 `React.memo`**，长会话输入才不卡（F7）。
9. **给会话加载加序号、给“迟到的页面切换”补一次重载**（F2/F4/F5）。

---

## 二、P0/P1：必须先修与建议本轮修复

> P0-1 的性质与其余项不同：它破坏的是**已经落库的会话历史**，修得越晚，坏掉的会话越多。

### P0-1 工具循环中途中止，历史里留下没有 `function_call_output` 的悬空 call

**位置**：`server/index.mjs:506-520`、`server/index.mjs:555-556`、`server/db.mjs:293-298`

**证据**：整轮 assistant（含全部 `tool_calls`）在 506-520 先落库，之后才进入 `for (const call of turn.calls)`；循环内只有 556 行一处 `if (controller.signal.aborted) break;`，break 后**不补写任何东西**。回放时 `db.mjs:293-298` 对 `tool_calls` 里每一项都 push `function_call`，从不检查有没有对应的 tool 行。

**触发**：一轮里模型返回 ≥2 个 tool call（很常见），执行到一半用户点「停止」/关侧栏（`res` close → `controller.abort()`），或后端被托盘重启；abort 恰好落在第一次 `runTool` 之前也同样触发。

**影响**：

1. `messages` 里 call 数与 tool 行数不一致；下一次请求的 `input` 带「有 call 无 output」的历史，严格校验的 provider 会直接 400，且这个会话此后每轮都失败；
2. 若该轮建立了 stateful 锚点，锚点指向的 response 里那条 call 永远没有 output，本地与上游状态从此不一致，回退到无状态也会重放同样的残缺对；
3. UI 侧该轮工具步骤永久停在 running（前端只在收到 `tool end` 时收尾）。

**建议**：不要把“assistant 行先落库、tool 行后补”当成两段独立写入。更稳的做法是：本轮 assistant 与全部 tool 行先在内存里攒齐（工具执行期间不持有事务），回合结束时**一个短事务**写入；中止/异常退出时，先为未执行的 call 生成 `function_call_output`（内容「用户已中止」），再一起提交，并把该轮标记 `aborted`。同时在 `rowsToItems` 加兜底——先收集本会话已有的 `tool_call_id` 集合，没有对应 tool 行的 `function_call` 不 push（或补一条 output），保证历史永远可重放。

---

### P1-1 响应头回来之前按「停止」，气泡永久停在「正在思考」

**位置**：`src/lib/chat.ts:193-196`、`src/entrypoints/sidepanel/App.tsx:642`、`App.tsx:805-811`

**证据**：

```ts
// chat.ts:193-196
} catch (err) {
  if ((err as Error).name === 'AbortError') return;   // 直接结束 generator
  throw new Error(t('error.unreachable', ...));
}
```

```tsx
// App.tsx:642 发送时先插入占位
{ id: firstAsstId, role: 'assistant', content: '', reasoning: '', streaming: true }
```

`App.tsx` 的 `finally`（805-811）只复位 `busy`、`abortRef`、`sendingRef`，**没有复位 `streaming`**；`catch`（783-804）只在 generator 抛错时执行。中止发生在**流式读取中间**时会命中 `catch`（`stopped` 分支会把 `streaming` 置 false），所以问题集中在“响应还没开始流”的窗口。

**触发条件**：

1. `fetch` 已发出、响应头还没回来时按「停止」（模型排队/后端冷启动时很常见）。`AbortError` 被 `chat.ts:194` 吞掉，`for await` 正常结束，App 的 `catch` 不执行。
2. 服务端在 `done` 之前**干净地**关闭 SSE（没有异常），`reader.read()` 返回 `done: true`，循环正常结束，同样没有收尾。后端进程被杀通常会给客户端一个网络错误、走 `catch`，不在此列；但反向代理超时、网关提前结束响应可能触发。

**影响**：占位 assistant 永久 `streaming: true` → `buildRounds` 里该轮 `running` 恒真：清爽模式永久显示呼吸点，详细模式永久展开「正在思考与调用工具…」。此时 `busy` 已变 false，用户可以继续发问，于是出现「新问题在上面、旧问题永远在思考」的错乱时间线，只能刷新侧栏。

**建议**：把“流式收尾”做成幂等函数，`catch` 与 `finally` 都调用一次——在 `finally` 里遍历当前消息，把所有 `streaming: true` 置 false；对“content 为空且没收到 done”的那条补一句“已停止/连接中断”或直接移除占位。`chat.ts` 不应静默吞掉 `AbortError`：用户主动停止可以 `yield { type: 'done', aborted: true }`，非预期中断应抛给调用方。

---

### P1-2 托盘「停止后端 / 重启后端」按端口无差别强杀进程

**位置**：`scripts/tray.ps1:113-133`

**证据**：

```powershell
Get-NetTCPConnection -LocalPort $script:Port -State Listen |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { Stop-Process -Id $_ -Force }
```

不校验进程名、可执行文件路径或命令行，`-Force` 不给任何保存机会，失败还被 `catch {}` 吞掉。

**影响**：8787 被其它 node / 服务占用时，点「停止后端 / 重启后端」会杀掉**无关进程**（可能是另一个项目的 dev server 或正在写库的进程），存在数据丢失风险；用户也看不到到底杀了谁。

**建议**：只杀命令行含 `server/index.mjs` 且 `ExecutablePath` 为 node 的 pid（`Get-CimInstance Win32_Process -Filter "ProcessId=$pid"` 校验）；否则只报告「端口被 `<pid> <name>` 占用，未处理」，把决定权交回用户。

---

### P1-3 `seed-settings.mjs` 写的是废弃存储键，并把明文 Key 落进浏览器

**位置**：`scripts/seed-settings.mjs:45`（另见 16-21、46-52）

**证据**：

```js
chrome.storage.local.set({ 'pageask.settings.v1': { baseUrl, model, apiKey } })
```

扩展只读 v2（`src/lib/settings.ts:14-15`）；v1 仅在 v2 不存在时用于迁移，且只取 `backendUrl`（`settings.ts:26-38`）。

**影响**：

1. 脚本对“配置好扩展”实际完全无效（`model` / `apiKey` 都不被使用），却打印“已写入设置”；
2. 明文 Key 进入 `chrome.storage`，落在 `.edge-profile9358\Default\Local Extension Settings\...`——该目录就在仓库根、且仓库没有 `.gitignore`，直接违反 `AGENTS.md` 的硬约束“Key 不进扩展、不进 chrome.storage”；
3. 46 行只检查 `exceptionDetails`，配额/其它失败仍报成功。

**建议**：要么只把 `backendUrl` 写进 v2，要么改成调后端 `POST /api/settings` 写 `~/.config/pageask/settings.json`（那才是唯一真源）；Key 一律不落浏览器。

---

### P1-4 仓库无 `.gitignore`，真实浏览数据、截图与 Key 配置文件裸露在仓库根

**位置**：仓库根（无 `.gitignore` / `.editorconfig` / `LICENSE`）；`server/data/`、`.output/`、`.npm-cache/`、`.edge-profile*`

**证据**：`server/data` 现有 `pageask.db` 573KB、`pageask.db-wal` 4.1MB、`shots/` 10 张真实页面截图 762KB、`pageask.log` 30KB、`tray.log` 4.3KB；`.output` 68 文件 / 2.1MB；`.npm-cache` 6.6MB；`edge-test.ps1` 的默认 profile 也在仓库根。

**影响**：目前只靠“没有 git 仓库”这道偶然防线。一旦 `git init`、压缩分享或云备份，会把用户浏览的页面、问答历史、界面截图一起带出去（DB 里不含 Key，但内容本身就是隐私）。

**建议**：加 `.gitignore`（`node_modules/`、`.output/`、`.wxt/`、`.npm-cache/`、`server/data/`、`.edge-profile*/`、`.env`、`*.log`）；长期可把 `server/data` 移到仓库外，或至少 README 明确“这是本机数据，不要提交/分享”。

---

### P1-5 打开 `PAGEASK_TOKEN` 后，扩展所有请求都 401

**位置**：`server/index.mjs:172`、`src/lib/chat.ts:170-192`

**证据**：前端只发 `headers: { 'Content-Type': 'application/json' }`，`src/` 全仓没有任何 `Authorization`，`src/lib/settings.ts` 的 `Settings` 也没有 token 字段；而 172 行对除 `/settings` 外的所有路径统一 `checkToken`。

**影响**：token 是文档里唯一的安全开关，一旦启用，`/chat`、`/pdf`、`/conversations`、`/health` 全部 401，扩展整体不可用；`scripts/tray.ps1:69-77` 读 `/health` 的 model 也会挂。**“更安全”的配置反而让产品不可用**，最终没人敢开。

**建议**：扩展设置里加 token（`Settings` 增加字段、请求统一带 `Authorization`），并在托盘/配置页提示；或明确 token 只约束脚本来源，把 `chrome-extension://` Origin 排除在校验外。

---

### P1-6 `/api/settings*` 在 token 之前，且能把 `baseUrl` 改到任意地址 → Key 可被诱导外发

**位置**：`server/index.mjs:130-152`、`server/index.mjs:155-170`（都在 172 的 token 校验之前）、`server/index.mjs:125`（CSP 无 `frame-ancestors`）

**证据**：130 行 `POST /api/settings` 直接 `writeSettings`，`baseUrl` 只校验 `/^https?:\/\//i`；155-163 行的 `/api/settings/test` 紧接着 `fetch(`${s.baseUrl}/models`, { headers: { Authorization: `Bearer ${s.apiKey}` } })`。

**影响**：本机任意进程两步即可拿到明文 Key——先把 `baseUrl` 指向自己的监听端口，再调 `/api/settings/test`（甚至不用第二步，用户下一次聊天就会把 Key 发过去）。另外配置页可被任意站点 iframe（CSP 缺 `frame-ancestors`），可配合「保存」按钮做点击劫持，把 `baseUrl` 改到攻击者地址。当前只靠“服务只绑 127.0.0.1”挡远程，挡不住本机进程与浏览器里的页面。

**建议**：`/api/settings*` 同样校验 token（配置页用一次性同源凭证）；`baseUrl` 强制 https（或仅允许 localhost 例外），拒绝私网/回环以外的内网地址指向；CSP 加 `frame-ancestors 'none'`；`/test` 只允许连已知端点，且不回显上游错误体。

---

### P1-7 配置解析失败会静默覆盖成默认值，把唯一一份 Key 清掉

**位置**：`server/settings.mjs:55-75`、`server/settings.mjs:86-89`

**证据**：

```js
try { raw = JSON.parse(readFileSync(settingsFile, 'utf8')); }
catch { raw = null; }           // 解析失败与“文件不存在”被当成同一件事
if (raw) return normalize(raw);
const initial = normalize({});  // 然后 writeSettings(initial) 直接覆盖
```

`writeFileSync(tmp, ..., 'utf8')` 未传 `mode`，`mkdirSync` 也未传 `0o700`。

**影响**：一次带 BOM 的手改、编辑器写坏、或磁盘半写，重启后 Key 就被默认值覆盖，且没有备份；同机其他账户在默认 ACL 下也可能读到 Key 文件。

**建议**：区分 `ENOENT` 与解析失败——只有文件不存在才写默认值；解析失败把原文件备份成 `settings.json.bad` 并报错，不自动覆盖；文件 `0600`、目录 `0700`（Windows 上用 ACL 或至少依赖用户目录默认保护并在 README 说明）。

---

### P1-8 中止/超时是否保留已生成正文取决于时序，注释却承诺“照样落盘”

**位置**：`server/index.mjs:434`（注释）、`server/index.mjs:686`、`server/index.mjs:625-634`、`server/index.mjs:672`

**证据**：434 行注释写的是“已产出的内容照样落盘”。实际有两条路径：

- 中止被 686 行的 `if (signal.aborted) break;` 在**两个 SSE 事件之间**观察到：跳出读循环，`content` 保留，随后 506 行照常落库——这条路径确实保住了正文，但 `aborted` 仍为 false；
- 中止发生在 `await reader.read()` / 响应头之前，或 672 行的 300s `AbortSignal.timeout` 触发：`streamTurn` 直接 throw，本轮 assistant **从未 `addMessage`**，而 `emit` 已经把 delta 推给前端——刷新即消失，token 已消耗。

**影响**：同一句“点停止”，有时历史里保住了半截、有时什么都没有，用户无法预期；300s 超时则稳定丢内容。若该轮已建立 stateful 锚点，上游存了这段而本地没有，下一轮链式上下文分叉。

**建议**：`streamTurn` 内部捕获 abort/timeout，把已累积的 `content`/`reasoning` 作为部分结果返回；调用方落库并标 `aborted: true`，`emit('done', { aborted: true })`；`autoTitle` 跳过。让“是否保留”不再取决于中止落在哪个 `await` 上。

---

### P1-9 所有出站抓取都没有独立超时，也不拦私网，且先全量进内存再查 64MB

**位置**：`server/index.mjs:308-317`（`downloadPdf`）、`server/tools.mjs:318-334`（`fetchPdf`）、`server/tools.mjs:348-360`（`fetchJson`）

**证据**：`fetch(url, { redirect: 'follow' })` 后直接 `await res.arrayBuffer()`，再判 `> 64MB`；没有 `AbortSignal.timeout`、没有私网/环回拦截、重定向不限跳数。

**影响**：一个超大响应或慢速服务就能把整个后端拖死/OOM（所有标签页共用一个进程）；模型可被页面内容诱导，用 `fetch_url` 去探测本机与内网端口（含 `127.0.0.1:8787` 自身）。这是“本地代理 + 模型工具”架构里最值得优先补的一道边界。

**建议**：DNS 解析后拒绝私网/环回/link-local；手动逐跳跟随重定向并每跳复检；`Content-Length` 预检 + 流式读满即断；每个出站请求加 30s 独立超时。

---

### P1-10 流被截断（没有 `response.completed`）时静默成功，落一条空回答

**位置**：`server/index.mjs:725-738`、`server/index.mjs:533-551`

**证据**：`const out = Array.isArray(final?.output) ? final.output : [];`，当 `final` 为 null（没收到 `response.completed`/`incomplete`）且此前也没有任何 delta 时，`finalText` / `content` 都为空，既不抛错也不 emit；随后 533 的「无工具调用」分支照常 `emit('done')` 并 `addMessage` 一条空 assistant。若此前已有 delta，则落半截且无 `incomplete` 标记。

**影响**：上游连接中途断开时，用户看到一次“成功但什么都没说”的回答，库里多一条空 assistant，真正的错误被吞掉；前端也不知道该重试还是报错。

**建议**：`final == null && !turn.content` 视为失败，抛 `UpstreamError('流提前结束')`，让 625 的 catch 走 `error` 事件；若已有部分正文，按 P1-8 落库并标 `incomplete`。

---

## 三、P2：按批次修复

### 3.1 扩展前端

#### F1 首个回答结束后 `busy` 滞留，输入被锁 1–20 秒

**位置**：`src/entrypoints/sidepanel/App.tsx:753-768`、`App.tsx:805-811`、`src/lib/chat.ts:263-276`、`server/index.mjs:549`

`done` 事件只把消息标成非流式，不清 `busy`；`busy` 只在生成器结束后由 `finally` 清。而 `streamChat` 收到 `done` 后不 `break`，继续读到服务端关连接；服务端在 `emit('done')` 之后还 `await autoTitle(...)`（最长 20s）才 `break` / `res.end()`。

**影响**：每个会话的第一次问答结束后，UI 仍显示「停止」、不能发送下一条；典型 1–3 秒，网络慢时接近 20 秒。后续轮次 `autoTitle` 条件不满足会立即返回，所以只影响首答/重生成后的首答。

**建议**：`done` 时立即 `setBusy(false)` 并允许发送，`title` 事件在后台继续更新；或服务端先 `res.end()`，再异步起标题（标题通过下次列表刷新带出）。

---

#### F2 生成中切换标签页：旧会话挂在新页面上，且不会自愈

**位置**：`App.tsx:418-445`

**证据**：

```tsx
useEffect(() => {
  if (!pageUrl || !settings) return;
  if (abortRef.current) return; // 正在生成时不打断
  ...
}, [pageUrl, settings, refreshConversations]);
```

**影响**：生成期间切页 → effect 提前返回；`abortRef` 不在依赖里，生成结束后**不会重跑**。结果是页面卡片/标题已换成新页，消息列表还是旧页的，`conversationId` 也是旧会话；用户在新页继续提问时会新建会话（后端 URL 不匹配兜底），但界面上旧消息仍在，形成“新会话里混着旧页问答”的错觉，刷新前无法恢复。

**建议**：不要在 effect 里“跳过”，而是记录 `pendingSwitch`，在 `finally` 里比对“当前 `pageUrl` 是否仍等于本次请求的页面”，不等则执行一次 `setConversationId(null); setMessages([]); setHistoryOpen(false)` 并重拉历史。更稳的做法是给每条消息打 `pageKey`，渲染时按 `pageKey` 过滤。

---

#### F3 改「显示详细信息」或后端地址会清空/替换当前正在看的会话

**位置**：`App.tsx:418-445`（依赖 `settings`，445 行）

**影响**：`verbose` 开关一改，effect 重跑 → `setMessages([])` 并自动加载“这一页最近一次会话”。用户正在翻看的旧会话被替换；如果那一页没有历史，界面直接清空。改后端地址触发重载是合理的，改显示偏好不该。

**建议**：拆依赖：`pageUrl` 或 `backendUrl` 变化才重载；`verbose` 只影响渲染。也可以把 effect 里的“自动续接最近会话”改成只在 `conversationId === null && messages.length === 0` 时执行。

---

#### F4 自动续接历史可能覆盖用户刚发出的消息

**位置**：`App.tsx:427-439`

拉历史是两次网络往返（`listConversations` → `getConversation`），期间用户发问会先插入用户消息 + 占位 assistant；随后 `setMessages(toMessages(conv.messages))` 整体覆盖，流式 token 找不到 `targetId`，`flush()` 的 `prev.map` 全部落空，界面表现为“发了但什么都没发生”，直到 `done` 后刷新列表才补回来。

**建议**：续接前加 `if (cancelled || sendingRef.current || messagesRef.current.length > 0) return;`（需要一份 `messages` 的 ref）；或把“自动续接”限制在页面刚打开、输入框为空的前 1–2 秒内。

---

#### F5 `openConversation` 无请求序号，失败时清空当前对话

**位置**：`App.tsx:858-879`、`App.tsx:891-900`

**影响**：后端慢时连点两条历史，后发先至会显示先点的那条；`getConversation` 失败时 `setMessages([错误气泡])` 把当前对话整个替换掉，而 `conversationId` 没变，屏幕上是一条错误、DB 里却是另一次对话，再提问会追加到“看不见的那次”里。删除会话失败也是同一模式。

**建议**：加 `loadSeq` ref，每次进入 +1，`await` 后比对；失败路径保留现有消息，用独立的 `errorBanner` state 报告，不要动 `messages`。

---

#### F6 输入框最大高度两处常量不一致，第 7 行被裁且无法滚动

**位置**：`App.tsx:33`、`App.tsx:956-982`、`src/entrypoints/sidepanel/style.css:839`

**证据**：

```tsx
const MAX_BOX_H = 168; // 注释称与 style.css 的 max-height 对应
const to = Math.min(natural, MAX_BOX_H);
el.style.overflowY = natural > MAX_BOX_H ? 'auto' : 'hidden';
```

```css
.editor { max-height: 156px; }
```

**影响**：`natural` 落在 `(156, 168]` 时 JS 判 `overflowY: hidden`，但 CSS 只允许 156px → 最后一行下半截（含光标）被静默裁掉，且不出现滚动条。约 7 行输入即可复现。

**建议**：常量只留一处——要么删掉 `MAX_BOX_H` 改读 `getComputedStyle(el).maxHeight`，要么在 `:root` 定义 `--box-max-h` 让 JS/CSS 共用；`overflowY` 与 `to` 使用同一个 limit 变量。

---

#### F7 每次击键 / 每 50ms 都让全部历史 Markdown + KaTeX 重解析

**位置**：`App.tsx:1316`（`onInput={() => setInput(serialize())}`）、`App.tsx:1230`、`src/components/MarkdownView.tsx:26-33`

`input` 是 App 的 state，每次击键整棵 `rounds.map` 重渲染；`MarkdownView` 没有 `React.memo`，内部 `remark → rehype-katex → renderToStaticMarkup` 对每条历史回答全量重跑（`useMemo` 只按 `text` 缓存，但组件本身仍重新执行）。长会话（10+ 回答、含公式）输入明显掉帧，流式期间 CPU 持续高位。

**建议**：① `MarkdownView` 包 `React.memo`；② 抽 `RoundItem` 并 memo，`onCopy` / `onRegenerate` 用 `useCallback` 稳定引用；③ 输入框只保留 `hasText` 布尔 state，文本内容不进 React 渲染链路（发送时仍读 DOM）。

---

#### F8 每次发送都截屏并随 `/chat` body 上传

**位置**：`App.tsx:682`、`App.tsx:701`、`src/lib/chat.ts:185`

无条件 `captureScreenshot()`，把当前可见画面（可能含私信、密码框、内部系统）POST 给本地后端；后端只在模型真的调用 `screenshot` 工具时才落盘，所以“不上传上游”成立，但“不留痕”不成立。4K 屏 jpeg q80 的 base64 可能到 2–3MB，叠加 400k 字符正文有撞上服务端 4MB 上限的风险；`captureVisibleTab` 还有 2 次/秒的限流。

**建议**：默认只在模型明确需要或用户勾选时截；低成本版是把 `quality` 降到 60、与 `readSelection` 并行（`Promise.all`，现在两个 await 串行），并在超限时自动降质重试。

---

#### F9 `captureVisibleTab` 未绑定 `windowId`，切窗口会截错图

**位置**：`src/lib/extract.ts:393`

`browser.tabs.captureVisibleTab({ format: 'jpeg', quality: 80 })` 抓的是“当前聚焦窗口的活动标签”，不一定是被问的那个标签。快速切页/切窗口会把 B 页画面附到 A 页的问题上，模型据此回答会完全跑偏，且很难察觉。

**建议**：从发起时的 tab 取 `windowId` 传入；截屏前再确认一次 `tab.url` 未变（可以用 `browser.tabs.get`）。

---

#### F10 「授权此站点并重试」是死路；`isConfigured` 恒真导致占位死代码

**位置**：`extract.ts:361-378`、`wxt.config.ts:11-14`、`App.tsx:927-931`、`src/lib/settings.ts:44`

`grantOrigin()` 调 `browser.permissions.request({ origins: [origin] })`，但 manifest 只有 `host_permissions: ['<all_urls>']`，**没有 `optional_host_permissions`** → Chrome 直接拒绝，被 `try/catch` 吞成 `false`，按钮点了没有任何反应、也没有错误提示。同时 `isConfigured()` 只判 `backendUrl` 非空，而 `pick()` 保证恒有默认值，所以 `App.tsx:1309-1310` 的“未配置”占位永远不会出现。

**建议**：删掉授权分支与 `noSettings` 占位；若要保留按钮，改成“重新加载页面后重试”（`tabs.reload` + 延时重试），并在失败时给出可见提示。

---

#### F11 `background.ts`：`openPanel` 是死代码，`contextMenus.create` 的 promise 拒绝没被捕获

**位置**：`src/entrypoints/background.ts:11-36`、`44-54`、`74-86`

- `openPanel`（11-35）定义后只有 `void openPanel;`（36），从未被调用；实际右键逻辑在 64-87 内联。读者会误以为有两条打开路径。
- `ensureMenu` 用同步 `try/catch` 包 `browser.contextMenus.create`；MV3 的 `browser.*` 是 promise 风格，重复 id 走的是 **rejection**，`catch` 抓不到 → 未捕获 rejection。
- 右键失败后的 `tabId` 重试发生在 `.catch` 里，已跨 microtask，用户手势多半失效，只会多写一条 `lastPanelOpen`。

**建议**：`void browser.contextMenus.create({...}).catch(() => {})`（或先 `removeAll()` 再 `create`）；删掉 `openPanel` 与 `void openPanel;`；打开侧栏只保留一个同步调用（`tab?.id > 0 ? { tabId } : { windowId: CURRENT }` 的三元，而不是 catch 链）。

---

#### F12 流式期间 `<details>` 无法收起，流结束还会整体重建

**位置**：`App.tsx:1186-1191`

```tsx
<details key={`${r.key}:${active ? 'run' : 'done'}`} className="round" open={active || undefined}>
```

`open` 由 React 控制为 `active`，每 50ms 一次 flush 都重渲染 → 用户刚收起，下一批 token 又弹开；`key` 里混入 `run/done` 会在流结束瞬间重建整个 `<details>`，展开状态与滚动位置被重置。

**建议**：改成非受控 + `defaultOpen`，只在 `active` 由 false→true 的那一次通过 ref 设 `open`；`key` 只用 `r.key`。

---

#### F13 Markdown 里的远程图片自动加载，链接未做协议白名单

**位置**：`src/components/MarkdownView.tsx:10-23`、`26-33`

只覆盖了 `a` 与 `table`，`img` 走默认渲染 → 模型输出 `![](https://x/track.png)` 时浏览器直接请求（IP、时间、UA 泄漏给对方，且撑开侧栏布局）。`href` 也没有协议过滤，`data:` / `blob:` 会原样透传，`javascript:` 依赖 React 的 URL 校验兜底，不应依赖。

**建议**：覆盖 `img`，渲染成“图片链接”文本或 `<img referrerPolicy="no-referrer" loading="lazy">`；`a` 的 `href` 只允许 `http(s):` / `mailto:`，否则渲染纯文本。

---

#### F14 `backendUrl` 可填任意地址，等于把全部页面内容外发

**位置**：`SettingsPanel.tsx:22-25`、`94-99`、`src/lib/settings.ts:46`

无任何主机校验，`https://evil.example` 也能保存 → 之后每次提问都把整页正文 + 选区 + 截图 + 全部历史 POST 过去；`SettingsPanel.tsx:94-99` 还会用 `browser.tabs.create` 打开它。对一个“只连 127.0.0.1”的自用扩展，这是最容易被钓鱼文案利用的一环。

**建议**：默认只允许 `http://127.0.0.1` / `http://localhost`（含端口），其它地址二次确认并在顶部常驻“非本机后端”警告；`/settings` 链接先做 `new URL()` 校验。

---

#### F15 「重新生成」先截断 UI，再可能直接 return

**位置**：`App.tsx:837-848`、`App.tsx:626-627`

`regenerateRound` 先 `setMessages(prev => prev.slice(0, cutAt + 1))`，再 `void send(...)`；`send` 在页面变成 `blocked` / `failed`（如跳到 `edge://`）或 `busy` 时提前返回 → 后续回答已从界面删除（DB 里还在），用户会以为丢了。

**建议**：先做与 `send` 相同的校验（`if (!page || !isConfigured(settings) || busy) return;`）再截断；或把截断移进 `send` 内部“确认能发”之后。

---

#### F16 剪贴板失败没有反馈；任意一轮 busy 时所有复制按钮消失

**位置**：`App.tsx:830`、`App.tsx:935`、`App.tsx:1238`

`navigator.clipboard.writeText` 无 `.catch` / 无 `try`，侧栏失焦或权限禁用时按钮无反馈且控制台一条 unhandled rejection。`App.tsx:1238` 的 `{isLastAnswer && !busy && m.content && (...)}` 让任意一轮生成时**所有历史回答**的复制/重生成按钮一起隐藏——`!busy` 只该约束“发送/停止”，不该约束“复制”。

**建议**：复制失败回退到 `setCopied(false)` 并给 toast；“复制”按钮不要依赖全局 `busy`，“重新生成”只在最后一轮且非 busy 时显示。

---

#### F17 发送前的两个 `await` 在 `try` 之外

**位置**：`App.tsx:682-687`

```tsx
const shot = await captureScreenshot();
const sel = await readSelection();
try {
  ...
```

任一 reject 会跳过 `finally` → `sendingRef.current` 永久 true、`busy` 卡住。两个函数目前内部都 catch（`extract.ts:416-419`、`312-314`），属潜在风险而非现网必现；但 `captureScreenshot` 未来若改成抛错就会踩中。

**建议**：把两次 await 移进 `try`，或在进入前用 `Promise.allSettled` 包一层。

---

#### F18 `readLocalPdf` 不检查 `parsed.ok`，后端错误被误报成“没有文字层”

**位置**：`src/lib/pdf.ts:70`

```ts
return finishPdf(parsed);   // parsed 可能是 {ok:false,error:...}
```

`finishPdf` 只看 `text`，`parsed.ok === false` 时会把后端的 500/超时/解析失败统一显示成「此 PDF 没有可抽取的文字层」，把用户引向错误方向。

**建议**：`if (!parsed.ok) throw new PdfReadError(parsed.error ?? ...)`，或在 `finishPdf` 里先判 `ok`。

---

#### F19 PDF 只按 URL 识别，无扩展名的 PDF 会被当网页注入

**位置**：`src/lib/extract.ts:216`、`src/lib/pdf.ts:29-40`

`looksLikePdfUrl` 只看 `.pdf` 后缀与少量 query 参数，不看 `Content-Type`；`blob:` / `data:` PDF 也识别不了。arxiv 式 `/pdf/2401.12345` 没有扩展名 → 走 `executeScript` 注入，PDF 查看器里必然失败，用户看到的是“无法读取”而不是“这是 PDF”。

**建议**：注入失败后做一次回退——若 tab URL 以 `/pdf/` 结尾或页面有 `<embed type="application/pdf">`，改走 `readPdfTab`；或在 `readActiveTab` 里先 `fetch(url, {method:'HEAD'})` 看 `content-type`（注意 cookie 与 CORS）。

---

### 3.2 后端

#### B1 `readJson` 在 `/chat` 与 `POST /conversations` 未捕获，非法 JSON 变成 500 + 原文

**位置**：`server/index.mjs:222`、`server/index.mjs:388`、`server/index.mjs:957-980`

`readJson` 内部 `JSON.parse` 会抛 `SyntaxError`；两处调用都没有 `try/catch`，落到顶层 `handle().catch` → 500，并把 `String(err.message)` 回给客户端。超大 body 走 `req.destroy()` 后同样可能以 500 收场。

**建议**：包一层返回 400 `invalid json` / `body too large`，不要把解析器原文回传；顶层 500 只回“internal error”，细节进日志。

---

#### B2 中止发生在 SSE 循环中间时，部分回答被当成功落库

**位置**：`server/index.mjs:686`

```js
if (signal.aborted) break;   // 直接跳出 while，不抛错
```

跳出后走的是正常路径：`turn` 已经 `addMessage` 落库，`aborted` 为 false，客户端收不到 `done(aborted:true)`；`autoTitle` 仍会跑。用户点停止后，历史里留下半截回答且没有“已停止”标记。

**建议**：中止时抛一个 `AbortError` 或设置 `turnAborted` 标志，落库时写 `aborted: true`，并 `emit('done', { aborted: true })`；`autoTitle` 跳过。

---

#### B3 `response.incomplete` 与 `completed` 同等对待；失败时丢掉真实状态码

**位置**：`server/index.mjs:713`、`server/index.mjs:723`

`incomplete`（达到 `max_output_tokens` 或被截断）被当成正常 final，用户看不到“回答被截断”；`throw new UpstreamError(500, JSON.stringify(failure))` 把上游的 400/429 等真实状态码抹成 500，`friendly()` 只能说“上游返回 500”。

**建议**：`incomplete` 时在 `done` 里带 `incomplete: true` 并让前端提示；失败分支保留 `failure.status ?? 500`，把上游错误体放进日志而不是直接拼进 message。

---

#### B4 `shotCache` 无上限、无淘汰，且一律标成 JPEG

**位置**：`server/db.mjs:316-326`

每条截图的 base64 data URL 缓存在一个全局 `Map`，删会话不清理，长跑内存持续增长；`data:image/jpeg` 硬编码，但 `saveShot` 允许 png/webp（扩展名来自 data URL 的 mime）。

**建议**：改成按会话 id 分组的 LRU（或直接不缓存，读盘一次即可）；MIME 从文件名后缀推断。

---

#### B5 `downloadPdf` / `fetchPdf` 无超时，先读完再查 64MB

**位置**：`server/index.mjs:308-317`、`server/tools.mjs:322-325`

`fetch(url)` 没传 `signal`（或只受对话 signal 控制），`await res.arrayBuffer()` 之后才检查大小 → 慢站/大文件可以长期占连接并吃掉内存；`/pdf` 的 `url` 分支与 `fetch_url` 抓 PDF 都走这条路。

**建议**：先看 `Content-Length`（缺失时流式累计并在超限时 `controller.abort()`），并给独立的 30s 超时。

---

#### B6 `fetch_url` 只校验协议，允许 localhost / 内网 / 云元数据地址

**位置**：`server/tools.mjs:271`

```js
if (!/^https?:\/\//i.test(url)) throw new ToolError(...)
```

请求由 `baseUrl` 指向的 Search & Fetch 服务发出，但 `baseUrl` 可配置成本机服务；模型可被页面内容诱导去请求 `http://169.254.169.254/...` 或内网管理端口。

**建议**：解析 hostname，拒绝回环、私有网段、链路本地与 `metadata.google.internal` 一类；至少加一个开关，默认关闭内网访问。

---

#### B7 `tool_calls` 不是数组时整轮 500

**位置**：`server/db.mjs:293`

```js
for (const call of safeJson(r.tool_calls) ?? []) {
```

历史数据被手工改坏、或旧版本写入对象而非数组时，`for...of` 抛 `TypeError`，`historyItems` 整轮失败 → `/chat` 500。

**建议**：`const calls = safeJson(r.tool_calls); if (!Array.isArray(calls)) continue;`。

---

#### B8 `truncateAfterLastUser` 按 rowid 批量删，双面板并发会误删

**位置**：`server/db.mjs:213-222`

```sql
DELETE FROM messages WHERE conversation_id = ? AND rowid > ?
```

两个侧栏同时重生成同一会话时，后一个会把前一个刚插入的行一起删掉。`addMessage` + `touchConversation` 也不在事务里（131-198），崩溃时可能留下半轮数据。

**建议**：重生成改为按 `id <= lastUserId` 保留、或删除时带 `id > ? AND role != 'user'` 的精确条件；`addMessage` 与 `touch` 包进 `BEGIN/COMMIT`。

---

#### B9 托盘探活只做 TCP connect，任何程序占端口都显示「运行中」

**位置**：`scripts/tray.ps1:55-67`、`79-80`、`324`

`Test-Backend` 只 `TcpClient.BeginConnect`，不看 HTTP 响应；`Start-Backend` 在 80 行“能连上就 return true”，看门狗同一判据。别的程序占住 8787 时，托盘显示“运行中”、菜单“启动后端”被禁用，真正的 PageAsk 永远不会被拉起。

**建议**：改成 `GET /health` 并校验返回体含 `ok` / `tools`（`server/index.mjs:175-189` 已提供）；拿不到就显示“端口被其它程序占用（pid/name）”。

---

#### B10 退出托盘不处理后端，留下无主 node

**位置**：`scripts/tray.ps1:303-308`

`$miQuit` 只 `Application::Exit()`，不调 `Stop-Backend`；下次 `pnpm tray:bg` 时 `Start-Backend` 因“能连上”直接返回 true，`$script:Child` 为 null，托盘此后没有自己的子进程句柄。用户以为关了，node 继续驻留占端口。

**建议**：退出时询问“同时停止后端？”或按配置默认停止；启动时若能连上就标记为“外部后端（pid=…）”，不要假装是自己拉起的。

---

#### B11 工具没有单次超时，工具循环也没有任何熔断

**位置**：`server/tools.mjs:348-360`、`server/tools.mjs:318-334`、`server/index.mjs:471`

工具只吃 `ctx.signal`（仅用户中止），单个 `web_search`/`fetch_url` 挂住时整轮卡死到用户点停止；`while (true)` 没有步数或总 token 上限，模型可以无限循环调用工具持续烧钱。`AGENTS.md` 明确“不设步数上限、用户点停止才结束”，这是产品选择，但**单次工具超时**不是选择，是缺失。

**建议**：每个工具 30s 独立超时（与对话 signal 分开，`AbortSignal.any`）；循环加“最多 N 步/最多 M token”的保险丝，触发时给模型一句“预算用尽，请收尾”，不要直接断开。

---

#### B12 任何 4xx 都永久降级 stateful；回退重跑会把已发的 delta 再发一遍

**位置**：`server/index.mjs:488-498`

链断判定用 `[400,404,409,422].includes(err.status)`，不区分“链不存在”与“参数错/内容过滤”，一次 400 就让本进程此后全部走无状态；回退时 `input = historyItems(...)` 重跑 `streamTurn` —— 若首次尝试已经 `emit` 过 `content` delta（例如上游先流了一段再报 422），第二次从头发一遍 → 前端出现重复段落。

**建议**：只对 `404`（或错误体明确含 `previous_response_id`/`not found`）降级；回退前记录已发长度，重跑时跳过相同前缀，或先 `emit('reset')` 让前端清掉本轮内容。

---

#### B13 final 文本与已发 delta 不一致时静默替换；首次建锚不设 `store`

**位置**：`server/index.mjs:731-737`、`server/index.mjs:662-667`

`finalText` 不以 `content` 开头时只改局部变量、不补发，前端显示与落库内容分叉；`store: true` 只在带 `previous_response_id` 时才加，首次请求依赖上游默认值（OpenAI 默认 true，但自建网关可能不是），若默认 false，第二轮必 404 并整进程降级。

**建议**：final 与 delta 不一致时以 final 为准并 `emit` 一次“校正”事件（或整段重发）；首次建锚也显式带 `store: true`。

---

#### B14 提示词边界：页面标题/URL 未隔离，`<untrusted_content>` 可被正文逃逸，cap 在 wrap 之前

**位置**：`server/index.mjs:820-821`、`server/tools.mjs:338-341`、`server/tools.mjs:230`

`当前页面：${page.title}` / `网址：${page.url}` 原样进 instructions，页面标题可写“忽略以上指令”；`wrap` 只转义 url/title，正文原样拼接，网页里出现 `</untrusted_content>` 就提前闭合；`read_page` 先 `cap` 再 `wrap`，包裹层约 150 字符，`RESULT_CAP=8000` 的硬保证实际不成立。

**建议**：标题/URL 用 JSON 转义或 `<page_meta>` 包裹；正文中的 `<`/`>` 转义，或每次生成随机边界串；`wrap` 之后再 `cap`（或 cap 时预留包裹长度）。

---

#### B15 regenerate 留下孤儿截图；`aborted` 列是死代码；写库无事务/无 `busy_timeout`

**位置**：`server/db.mjs:213-222`、`server/db.mjs:57/147/172`、`server/index.mjs:506-520`、`server/db.mjs:23-25`、`server/db.mjs:131-198`

`truncateAfterLastUser` 只 `DELETE FROM messages`，不删 `shots/` 文件、不 `touch updated_at`；`aborted` 列定义了、`addMessage` 也收了形参，但 `index.mjs` 从不传 `aborted: true`；`addMessage` 的 INSERT 与 `touchConversation` 是两条语句；`DatabaseSync` 没设 `busy_timeout`，并发写直接 `SQLITE_BUSY` → 500。

**建议**：重生成时先查该轮截图路径并删除；中止路径写 `aborted: true`；`addMessage` + `touch` 包进 `BEGIN/COMMIT`；开库时 `PRAGMA busy_timeout = 5000`。

---

#### B16 `baseUrl` 的路径约定不一致，换自建网关必有一边 404

**位置**：`server/index.mjs:160`、`server/index.mjs:332`、`server/index.mjs:668`、`server/tools.mjs:244`、`server/tools.mjs:289`

对话与标题用 `${baseUrl}/responses`、`${baseUrl}/models`，搜索/抓取用 `${baseUrl}/v1/tools/search`、`${baseUrl}/v1/tools/fetch`。同一份配置要同时满足“带 /v1”和“不带 /v1”两种前缀；DeepSeek 官方恰好两者都通，自建网关通常只认一种。

**建议**：统一成“baseUrl 不含 /v1，由代码拼 `/v1/...`”，或为 Search & Fetch 单独加配置项；在配置页/README 写清约定。

---

#### B17 超时把 DOMException 英文原文透给前端；无状态模式 usage 重复计入历史

**位置**：`server/index.mjs:625-633`、`server/index.mjs:500-503`

300s 超时不是 abort，走 `isAbort=false` 分支，`err.message` 是英文 `The operation was aborted due to timeout`；无状态模式每轮重发完整历史，`input_tokens` 是累计值，直接相加会高估“本轮消耗”。

**建议**：超时单独识别（`err.name === 'TimeoutError'`）并给中文文案；totals 要么展示“累计处理 token”，要么用 `input_tokens - 历史长度估算` 标成“新增”。

---

#### B18 `/pdf` 的 4xx 回成 502 并回显绝对路径；响应缺 `nosniff`，CSP 缺 `frame-ancestors`

**位置**：`server/index.mjs:282-286`、`server/index.mjs:295-303`、`server/index.mjs:951-955`、`server/index.mjs:125`

`readFileSync` 的失败信息带完整路径（存在性/权限 oracle）；缺 `url`/坏 base64 这类客户端错误也回 502；所有响应没有 `X-Content-Type-Options: nosniff`；配置页可被任意站点 iframe。

**建议**：参数错误回 400，读盘失败只回“无法读取该文件”并记日志；统一加 `nosniff`、`Referrer-Policy: no-referrer`；CSP 加 `frame-ancestors 'none'`。

---

#### B19 配置页把 401 当成“无法连接”；短 Key 的掩码泄露前 2 位

**位置**：`server/webui.mjs:141-152`、`server/settings.mjs:123-128`

设了 token 后 `/health` 401，页面显示“无法连接”，与实际状态相反；`maskKey` 对 ≤10 位的 Key 只遮 2 位之后的部分（`sk` 开头会露出来）。

**建议**：区分 401/403 与网络失败，提示“需要 token”；短 Key 只保留末 2 位或全遮。

---

#### B20 无优雅退出；同一张截图重复落盘；`statsFor` 每次全表扫描

**位置**：`server/index.mjs`（无 `SIGINT`/`SIGTERM` 处理）、`server/index.mjs:581` + `server/tools.mjs:121-137`、`server/db.mjs:332-345`

Ctrl+C / 托盘重启时 `db.close()` 不执行、进行中的 SSE 不 end，WAL 可能留下未 checkpoint 的尾巴；每次 `screenshot` 工具调用都把同一个 data URL 再写一个文件，没有去重也没有磁盘上限；`statsFor` 把该会话全部消息正文读进内存，却只在 `autoTitle` 里判断“是否首轮”用一次。

**建议**：注册 `SIGINT`/`SIGTERM`，`db.close()` + 广播 abort + `server.close()`；截图按 hash 去重或只保留最近 N 张；`statsFor` 改成两条 `COUNT(*)` + 两条 `LIMIT 1` 查询，不要拉全文。

---

### 3.3 工程化与文档

#### E1 `pnpm compile` 完全不覆盖后端与脚本

**位置**：`package.json:13`、`.wxt/tsconfig.json`

`tsc --noEmit` 的 include 只覆盖 `src`；`server/` 与 `scripts/` 的 `.mjs` 不在检查范围（子代理实测 333 个文件、`.mjs` 0 个）。999 行 `server/index.mjs` 与 18 个脚本全靠人眼，改 SSE 字段或工具参数没有编译期兜底。

**建议**：加 `tsconfig.server.json`（`allowJs` + `checkJs`，include `server/`、`scripts/`），或最低成本用 `node --check` 遍历；合成一个 `pnpm verify`。

---

#### E2 Node 下限漂移：文档写 22.5，依赖实际要 22.13

**位置**：`README.md:12`、`package.json`（无 `engines`）、`pnpm-lock.yaml` 中 `pdfjs-dist@6.5.438`

`pdfjs-dist` 的 engines 是 `>=22.13.0 || >=24`，wxt 是 `>=22`；README 只写 `>=22.5`，`package.json` 没有 `engines`，启动脚本也不校验 `node -v`。22.5–22.12 的机器会撞引擎告警或 pdfjs 动态 import 失败，而托盘只往 `server.err.log` 写一行 `start aborted`。

**建议**：README 改成 `>=22.13` 并注明原因；`package.json` 加 `engines`；`start-server.ps1` 开头做一次版本检查并输出中文提示。

---

#### E3 `minimum_chrome_version: '114'` 低于 `sidePanel.open()` 的要求

**位置**：`wxt.config.ts:10`、`background.ts:19`、`75`

`sidePanel.open()` 需要 116+；右键菜单（75 行）是 PDF 场景的唯一入口。在声明的 114/115 上，右键只会走 catch，写一条 `lastPanelOpen`，用户看到“点了没反应”。

**建议**：抬到 116 或更高；顺带把 manifest version 改成从 `package.json` 读。

---

#### E4 测试脚本不可重复，且会污染真实数据

**位置**：`scripts/test-*.mjs`、`package.json`（无 `test`）

- `test-chat.mjs` / `test-selection-context.mjs` 硬编码 `127.0.0.1:8811`，仓库里没有 8811 的静态服务脚本；
- 所有脚本默认打真实 `127.0.0.1:8787` + 真实 Key + 真实 `server/data` DB，跑一次就给会话列表塞进“缓存测试页”这类垃圾会话；
- `test-cache.mjs` 默认读 `.cache-shot.jpg`，仓库根没有这个文件，新环境直接 ENOENT；
- 除 `test-hist-time.mjs` 外没有断言，也不返回非 0 退出码。

**建议**：URL 从 `PAGEASK_BASE_URL` 读；测试数据用 `PAGEASK_DATA_DIR` 指到临时目录（`server/settings.mjs:16` 已支持）；`test-cache` 的截图改成必填参数或内联常量；每个脚本给出退出码与一条“PASS/FAIL”摘要。

---

#### E5 文档与源码冲突（零依赖 / Key 配置方式 / 配置路径）

**位置**：`README.md:6`、`PLAN.md:304`、`387-389`、`470`、`scripts/start-server.ps1:3`、`scripts/tray.ps1:88`

- README 与 PLAN 都称后端“零第三方依赖”，实际 `server/pdf.mjs:14` 用 pdfjs-dist；
- PLAN 教用 `DEEPSEEK_API_KEY` 环境变量或 `server/.env`（还引用了不存在的 `.env.example`），`server/settings.mjs` 已明确不读这些变量；
- 两个启动脚本注释说配置在 `server/data/settings.json`，实际是 `~/.config/pageask/settings.json`。

**建议**：README 用一句显式写明“配置只有一个来源：`~/.config/pageask/settings.json`”；PLAN 早期小节加“已废弃”标注或删除；两处脚本注释改路径。

---

#### E6 版本号三处分裂；无 lint / format / CI

**位置**：`PLAN.md:1`（标题停在 v0.7）vs `PLAN.md:1918`（§50，正文已到 v0.11/v0.12）；`package.json:5`；`wxt.config.ts:8`；`server/index.mjs:38-44`

PLAN 标题与正文各说各话，`package.json` 与 manifest 两处手写 `0.1.0`，配置页显示的版本来自 package.json。没有 ESLint / Prettier / CI；`ppackage.json` 里既无 `lint` 也无 `test`，`zip` 也没有 `:edge` 变体。

**建议**：manifest `version: pkg.version`；PLAN 标题去掉版本号或与 package 联动；补 ESLint（至少 `no-unused-vars` / `no-floating-promises`）与一个最小 CI（`pnpm compile` + `verify`）。

---

## 四、P3：整洁度、可访问性与边角

| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| T1 | `src/lib/i18n.ts:66-161` | 未使用 key：`page.failure.internalPage`、`pdfFileAccess`、`think.streaming/done`、`quote.prefix/remove`、`action.openPanel`；`page.failure.blockedRaw` 是英文文案却直接展示；151 行缩进异常 | 删未用 key，英文文案改中文 |
| T2 | `i18n.ts` `history.count` vs `server/db.mjs:78` | 「共 N 轮」按 `role IN ('user','assistant')` 计数，每次工具调用多一段 assistant → 轮数虚高 | 后端改 `COUNT(*) WHERE role='user'`，或文案改“条” |
| T3 | `style.css:172-195`、`669-691`、`1096`、`262`、`242`、`1063` | 死 CSS：`.dot*`、`.think*`、`.icon-only`、`.linkish`、`button.primary.sm`、`.field code`；`--warn-dot` 无引用 | 删除 |
| T4 | `style.css:955-971` | `.conv-del` 默认 `opacity: 0`，仅 hover/`.on` 显示 → Tab 焦点落在不可见删除按钮 | 加 `:focus-visible` 显示，或默认 `visibility` 可控 |
| T5 | `App.tsx:1305`、`style.css:853` | contenteditable 有 `role="textbox"` 但无 `aria-label`；占位文字是 CSS `:empty::before`，读屏读不到 | 加 `aria-label`，占位用真实 `placeholder` 或 `aria-placeholder` |
| T6 | `App.tsx` 全局 | 流式正文/工具状态无 `aria-live`；无 `prefers-reduced-motion` 兜底 | 加 `aria-live="polite"` 与 reduced-motion 媒体查询 |
| T7 | `App.tsx:909`、`921` | 换行/粘贴仍用已废弃的 `document.execCommand('insertText')` | 长期换 `beforeinput` / `Range` 插入；短期至少补 `DIV/P` 换行序列化 |
| T8 | `App.tsx:830` | 复制成功提示的 `setTimeout` 未在卸载时清理 | 存进 ref，卸载时清 |
| T9 | `src/lib/settings.ts:51-58` | `normalizeUrl` 只去 hash、保留 query → 带 `?utm_*` 的同一文章分裂成多个会话 | 去掉已知追踪参数，或只保留 path |
| T10 | `extract.ts:381-383` | `estimateTokens = chars * 0.6`，注释说“英文 4 字符/token”，实现与注释不符 | 改注释或按中英文比例估算 |
| T11 | `extract.ts:393`、`408` | 截图先 JPEG q80 再转 q72，二次压缩 | 直接 `captureVisibleTab` 一次到位，或先 PNG 再转 |
| T12 | `extract.ts:174-185`、`356` | `classify` 只匹配英文报错，中文 Edge 归到 `unknown`；`readPdfTab` 所有异常一律 `unknown` | 补中文关键字；区分网络/权限/解析失败 |
| T13 | `server/pdf.mjs:37-53`、`84` | `getDocument` 失败时 `loadingTask.destroy()` 不执行（内存泄漏）；单页解析失败把错误文字混进正文 | `finally` 里对 `loadingTask` 兜底 destroy；错误页跳过或单独标记 |
| T14 | `server/pdf.mjs:92-125` | `joinTextItems` 不在无 EOL 的 item 间补空格，部分 PDF 会粘词 | 按 `item.transform` 的 x 间距判断是否补空格 |
| T15 | `server/index.mjs:175-189` | `/health` 无鉴权即返回 `settingsFile`、`db` 绝对路径 | 去掉路径或只在带 token 时返回 |
| T16 | `server/index.mjs:202` | `decodeURIComponent` 可抛 `URIError`，未捕获 → 500 | 包 try/catch，返回 400 |
| T17 | `server/index.mjs:94-100` | 顶层 `handle().catch` 把 `String(err.message)` 500 回传，可能泄漏内部路径/上游原文 | 只回“internal error”，细节进日志 |
| T18 | `server/index.mjs:428` | `res.write` 不处理背压 | 返回 false 时 `await once(res, 'drain')` |
| T19 | `server/index.mjs:948` | `checkToken` 用普通字符串比较 | 本地单用户风险低；可用 `crypto.timingSafeEqual` |
| T20 | `server/index.mjs:904-929` | SSE 解析只按 `\n\n` 切块、`event:`/`data:` 单空格；CRLF 上游会整段失败 | 同时支持 `\r\n\r\n`，多行 data 已用 `\n` 拼接 |
| T21 | `server/db.mjs:284` | 回放时伪造 reasoning id `rs_${r.id}` | 文档标注“仅展示/回放用”，或存真实 id |
| T22 | `server/settings.mjs` | Key 文件未显式收紧权限；`apiKey:''` 表示不改，UI 无法清空 Key | 写入时 `chmod 600`（Windows 用 ACL）；加“清除 Key”语义 |
| T23 | `server/webui.mjs:56` | 版本号直接插 HTML（来自 package.json，可信）；CSP 允许 inline script | 保持；如未来引入外部输入需转义 |
| T24 | `src/lib/settings.ts:37` | 无存储时返回共享 `DEFAULT_SETTINGS` 对象，调用方误改会污染默认值 | 返回 `{ ...DEFAULT_SETTINGS }` |
| T25 | `src/lib/pdf.ts:57`、`97` | 重复实现“去尾斜杠”，与 `settings.ts:46` 的 `baseUrl()` 重复 | 复用 |
| T26 | `scripts/test-shot.mjs:9-18` | 注释写“64x64 纯红 PNG”，base64 实际是 1×1，却仍传 `screenshotWidth: 64` | 改成真实 64×64，或按 1×1 断言 |
| T27 | `scripts/test-hist-time.mjs:7-19` | 把 `App.tsx:203` 的 `fmtTime` 整段复制，测的是副本 | 导出 `fmtTime` 后直接 import |
| T28 | `scripts/cdp-*.mjs`、`probe-sw.mjs`、`seed-settings.mjs` | 默认 CDP 端口 9222，而 `edge-test.ps1` 默认 9358；`edge-test.ps1:36` 写死 `Program Files (x86)` | 统一 `--port` 参数与安装路径探测 |
| T29 | `scripts/tray.ps1:197-201`、`170/174` | Mutex 未处理 `AbandonedMutexException`；自启快捷方式不带 `-Port`，`-Port 9000` 安装后自启仍跑 8787 | try/catch 重试；快捷方式带上参数 |
| T30 | `AGENTS.md` §5、`README.md:80` | 文档写 `busyRef`，代码是 `sendingRef`；README 文件表漏 `server.err.log`、`.edge-profile*` | 改文档 |
| T31 | `App.tsx:67-69`、`1199` | `seconds(null)` 返回 `0.0`，老会话显示“思考了 0.0 秒” | 返回 `null`，调用方隐藏 |
| T32 | `i18n.ts` `time.md` / `time.ymd` | 日期分隔符一套 `/` 一套 `-`，同屏不统一 | 统一 |
| T33 | `App.tsx:813` | `send` 的 `useCallback` 依赖含 `input`，函数体未使用 → 每击键重建 `send`/`onKeyDown` | 删依赖 |
| T34 | `MarkdownView.tsx` | `rehypePlugins as never` 强转 | 用正确的插件类型，或局部 `@ts-expect-error` 加原因 |
| T35 | `server/index.mjs:425-427` vs `465` | emit 闭包引用 465 才声明的 `started`，靠“首个事件是 meta”才没踩 TDZ | 把 `started` 提到 emit 之前声明 |
| T36 | `server/index.mjs:983-999` | `loadDotEnv` 不剥行内注释、不处理 `export` 前缀；且已不被文档推荐 | 删掉或写进 README 的“仅调试” |
| T37 | `server/tools.mjs:11-94` | `TOOL_SPECS` 与 `RESPONSES_TOOLS` 两份定义手工同步，字段漂移无人发现 | 用 `TOOL_SPECS.map(flatten)` 生成 |
| T38 | `server/settings.mjs:39-46` | 非法 `state` 被静默归一成 `auto`，`/api/settings` 仍回 200 | 校验失败回 400 并给出合法值 |
| T39 | `AGENTS.md` §5 vs `server/db.mjs:281-289` | 文档说“不要回传 reasoning item”，代码回传带伪造 id 的 reasoning item（实测 200） | 以代码为准更新文档，或删回传 |

---

## 五、亮点清单（避免只列问题）

1. **注入函数自包含**：`grabPage` 与 `readSelection` 只引用全局，满足 `executeScript` 的序列化约束；注释里也写明了这一点。
2. **工具结果的安全边界**：统一 `<untrusted_content>` + 8000 字硬截断 + “这是数据不是指令”的提示词，方向正确。
3. **中止链路**：`req` / `res` 的 `close` / `error` 都挂 `abort()`，并注释了“res 更可靠”的原因；循环内多处检查 `aborted/destroyed`。
4. **有状态链的回退是结构性的**：`anchor != null && UpstreamError && [400,404,409,422]` 才判定断链，不靠错误文案；失败后全量重发一次并记日志。
5. **前端并发闸门**：`sendingRef` 同步防连点、`seq` 丢弃过期加载、50ms 批量 flush、贴底 + `ResizeObserver`，都是实战收敛出来的。
6. **引用 chip 的实现**：`contentEditable=false` 原子元素 + `dataset.quote` 序列化成 `<q>…</q>`，选区上下文带 start/end，模型能准确知道“它”指什么。
7. **配置页安全**：CSP `default-src 'none'`、`textContent` 填值、Key `type=password` + 掩码、保存后清空输入框。
8. **日志纪律**：前端只显示一句话，状态码/上游原文/工具参数进 JSON 日志；`logEvent` 永不抛错。
9. **文档化决策**：`PLAN.md` 把“为什么不用快捷键 / 为什么不在 SW 里 open / 为什么 state=auto 保守”都写下来了，这是很多项目缺的。

---

## 六、建议的修复顺序

### 第一批（半天到一天，止血）

1. P0-1 工具循环事务化 + 为未执行的 call 补 `function_call_output` + 回放兜底；
2. P1-8 中止/超时把已生成正文落库并标 `aborted`；
3. P1-1 流式收尾兜底 + `chat.ts` 不再静默吞 `AbortError`；
4. F1 `done` 释放 `busy`（或服务端先 `res.end` 再起标题）；
5. F6 统一 168/156；
6. F7 `MarkdownView` memo；
7. F10 删授权死路与 `noSettings` 占位；
8. P1-3 改 `seed-settings`，P1-4 加 `.gitignore`。

### 第二批（1–2 天，正确性）

1. P1-6 配置端点鉴权 + `baseUrl` 约束 + `frame-ancestors`；
2. P1-7 配置失败不覆盖、0600/0700；
3. P1-5 token 贯通到扩展（或明确只约束脚本）；
4. P1-9 出站超时/私网拦截/流式大小上限；P1-10 空流报错；
5. F2/F4/F5 统一“页面/会话归属 + 加载序号 + 迟到切换”；
6. F3 拆 effect 依赖，`verbose` 不再重载会话；
7. F8/F9 截图按需 + `windowId`；
8. F13/F14 图片/协议白名单 + `backendUrl` 回环校验；
9. B1/B2/B3 后端错误边界与中止语义；
10. F18/F19 PDF 错误透传与识别回退。

### 第三批（工程化，持续）

1. E1 `pnpm verify`（tsc + checkJs + `node --check` + 配置一致性自检）；
2. E2/E3 `engines` 与 `minimum_chrome_version`；
3. E4 测试脚本改成可重复（env + 临时 data dir + 断言 + 退出码）；
4. B9/B10 托盘按 `/health` 判活、按 pid 身份停止、退出时处理子进程；
5. E6 ESLint + 最小 CI；逐步拆 `App.tsx` 的流式状态机（`useChatStream`）。

### 验证建议

- 每批修完至少跑：`pnpm compile`、`pnpm build`、起后端后 `curl /health`、`node scripts/test-chat.mjs`（用临时 `PAGEASK_DATA_DIR`）。
- UI 侧用 `scripts/edge-test.ps1` + CDP 脚本覆盖三条路径：首答后立刻再发、生成中切标签、停止后重发。
- 修 P1-1 时专门测“响应头到达前按停止”和“kill 后端进程”两种断流。
- 修 P0-1 时构造一轮 ≥2 个 tool call：执行第一个后点停止，再发下一条问题；确认该轮每个 `function_call` 都有对应 `function_call_output`（查 DB 或看下一轮不再 400）。

---

## 七、附录

### 7.1 规模度量

| 区域 | 主要文件 | 行数（约） |
|---|---|---:|
| 侧栏 UI | `App.tsx` 1346、`style.css` 1273、`SettingsPanel.tsx` 111 | 2730 |
| 扩展逻辑 | `extract.ts` 420、`chat.ts` 294、`pdf.ts` 132、`i18n.ts` 195、`settings.ts` 59、`background.ts` 88 | 1188 |
| 组件/入口 | `MarkdownView.tsx`、`icons.tsx`、`main.tsx`、`index.html` | 141 |
| 后端 | `index.mjs` 999、`db.mjs` 394、`tools.mjs` 388、`settings.mjs` 142、`webui.mjs` 192、`pdf.mjs` 132、`text.mjs` 36、`log.mjs` 35 | 2318 |
| 脚本 | `tray.ps1` 351、`edge-test.ps1`、`test-*.mjs`、`cdp-*.mjs`、`probe-*.mjs` 等 18 个 | ~1500 |
| 合计 | | **~7.9k** |

### 7.2 设施现状

- 无 git 仓库、无 `.gitignore`、无 `.editorconfig`、无 LICENSE；
- 无 ESLint / Prettier / 测试框架 / CI；
- `pnpm compile` 只覆盖 `src`；
- 依赖：React 19、WXT 0.21、TypeScript 7、Defuddle 0.19、pdfjs-dist 6.5、KaTeX 0.16、react-markdown 10；后端唯一第三方依赖是 pdfjs-dist（与 README 的“零依赖”不符）。

### 7.3 本次审查的边界

- 只读：未修改任何源码，未启动后端 / Edge / 托盘，未写注册表或 Startup；
- 未做：动态渗透、依赖 CVE 扫描、真实模型端到端回归、长会话内存压测；
- P0/P1 中的“隐私数据在仓库根”是**条件性风险**（当前无 git 仓库），按“一旦提交/分享就会泄漏”定级；P1-5/P1-6/P1-7 的利用前提是本机同用户进程或用户被诱导点击，按“本机安全边界”而非“远程可利用”定级。

---

*报告生成：2026-11-07。问题定位以当前工作区源码为准；若后续代码变动，行号可能漂移。*

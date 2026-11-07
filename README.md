# PageAsk

Edge 侧栏扩展：就**当前标签页**的内容向 AI 提问（网页 / PDF 都行）。AI 的 Key 只放在本地后端，浏览器里没有 Key。

- 扩展：WXT + React + Defuddle（正文提取）
- 后端：`node server/index.mjs`，只监听 `127.0.0.1:8787`；核心零第三方依赖（`node:sqlite`），PDF 文字层用 `pdfjs-dist`（与扩展共用同一份依赖）

## 0. 前置条件

| 需要 | 说明 |
| --- | --- |
| Node.js **≥ 22.13** | 内置 `node:sqlite` 要求 22.5+；`pdfjs-dist` 6.x 实际要求 22.13+（本机实测 24.18） |
| pnpm | `corepack enable` 或单独安装 |
| Microsoft Edge | 用「加载解压缩扩展」方式安装，**开发者模式必须打开** |

## 1. 装依赖 + 构建扩展

```powershell
pnpm install
pnpm build          # 产物：.output\chrome-mv3
```

## 2. 起后端（第一次会因为没有 Key 而提示）

```powershell
pnpm server:win     # 或 pnpm server；想让它脱离终端见下面的「托盘」
```

第一次运行时后端会自己生成配置文件：

```
C:\Users\<你>\.config\pageask\settings.json
```

内容是默认值（`baseUrl` / `model` / 空的 `apiKey`）。目录不存在会自动创建。

## 3. 填 API Key

浏览器打开 **<http://127.0.0.1:8787/settings>**（后端启动日志里也会打印这个地址），填 DeepSeek 的 Key，点「保存」。

- 保存即生效，**不用重启后端**
- 已保存的 Key 只显示头尾（`sk-554…f398`），留空保存表示「不修改」
- 「测试连接」会拿当前配置请求一次上游 `/models`

> 没填 Key 就想提问时，扩展里会直接显示：
> `还没有配置 API Key：打开 http://127.0.0.1:8787/settings 填一个（或在托盘菜单里点「配置…」）`

## 4. 把扩展加载进 Edge

1. 地址栏输入 `edge://extensions`
2. 打开左下角（或页面侧栏）的**开发人员模式**
3. 点「加载解压缩的扩展」，选 `.output\chrome-mv3`

> 每次重新 `pnpm build` 之后，要在扩展页点一次「重新加载」；`pnpm dev` 则会自己热更新。

## 5. 开始用

- **右键网页 →「用 PageAsk 询问本页」**（PDF 阅读器里也有这一项），或点工具栏上的 PageAsk 图标：右侧会打开侧栏
- 侧栏顶部显示当前页面（标题 / 字数 / tokens / 提取耗时），下面直接提问
- 选中回答里的文字会出现「引用」按钮；输入框里可以引用多段，退格一次删掉整块
- 每条回答下面有复制 / 重新生成，以及本轮耗时与 token 统计（「显示详细信息」关掉后这些都不显示）

## 6. （可选）托盘常驻 + 开机自启

```powershell
pnpm tray:bg        # 后台运行，不占终端（等价于前台 pnpm tray）
```

托盘图标右键可：启动 / 停止 / 重启后端、配置…、打开日志、打开数据目录、开机自启、退出。

- 「停止后端」是**真的停**：看门狗不会把它拉起来，直到你点「启动后端」或「重启后端」
- 后端崩溃（不是你停的）时，看门狗 4 秒内自动重启
- 开机自启会写一个 Startup 快捷方式，优先用 PowerShell 7（`pwsh`）运行

## 文件都在哪

| 内容 | 位置 |
| --- | --- |
| 配置（Key / 上游地址 / 默认模型） | `%USERPROFILE%\.config\pageask\settings.json` |
| 会话数据库、截图、日志 | `server\data\`（`pageask.db`、`shots\`、`pageask.log`、`tray.log`） |
| 扩展构建产物 | `.output\chrome-mv3` |

## 常见问题

**侧栏说「读不到这个页面」**：当前标签是 `edge://` 内部页 / 扩展商店 / PDF 的某些状态，浏览器不允许脚本注入。换普通网页即可。

**PDF 打不开**：`file://` 的 PDF 由后端读盘解析，需要同一台机器上的后端在跑；扩展页自己 `fetch` 不了 `file:`。

**切了标签，侧栏不见了**：Edge 的已知缺陷（microsoft/MicrosoftEdge-Extensions#142），再点一次图标即可。

**改了代码不生效**：扩展要「重新加载」，后端要重启（`pnpm server:win`），改的是 `settings.json` 则不用重启。

**后端说「还没有 API Key」**：见第 3 步，或托盘菜单「配置…」。

## 开发

```powershell
pnpm dev            # WXT dev（Chrome）
pnpm dev:edge       # WXT dev（Edge）
pnpm compile        # tsc 类型检查 + server/scripts 的 .mjs 语法检查
pnpm test:server    # 后端回归脚本（数据目录全部用临时目录）
pnpm verify         # compile + test:server + build，提交前跑这个
pnpm build          # 生产构建
```

侧栏代码按职责拆分：`App.tsx` 只编排状态机与请求生命周期，消息模型在 `messages.ts`，contenteditable 操作在 `editorDom.ts`，展示组件为 `Composer` / `HistoryPanel` / `PageCard` / `RoundPanel` / `SettingsPanel`。

CI 在 `.github/workflows/ci.yml`：Windows + Node 22.13 + `pnpm verify`，`push` 到 `main` 或开 PR 时运行（仓库当前没有 remote，推送后才会生效）。

设计与决策的早期记录已归档在 [`PLAN.md`](PLAN.md)（仅历史参考，不再维护）；现行架构与协作规则见 [`AGENTS.md`](AGENTS.md)，审查与修复记录见 [`docs/code-review-2026-11-07.md`](docs/code-review-2026-11-07.md)。

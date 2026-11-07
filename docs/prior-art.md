# 同类项目调研笔记（2026-11）

目标：找一个「Edge 侧栏 + 就当前页面内容问 AI」的参照实现，确认技术路线可行，并抄它该抄的部分。

## 1. 结论先行

- 这条赛道已经很成熟，**不需要从零发明**：功能形态几乎都是「侧栏聊天 + 正文提取 + 自带 Key（BYOK）」。
- 开源阵营里只有两个项目值得读代码：**Page Assist**（本地模型路线，工程完整）和 **ChatGPTBox**（多浏览器路线，正文提取经典）。
- 本体技术栈在 2023 年就定型了：`chrome.sidePanel`（MV3）+ `executeScript` 取 DOM + Readability 类算法提正文 + SSE 流式对话。2026 年没有本质变化，变化只在模型接入选型。

## 2. 第一梯队：值得读源码的两个项目

### Page Assist — 8,306 stars / MIT / TypeScript

- 仓库：https://github.com/n4ze3m/page-assist
- 定位：本地模型（Ollama 等）的浏览器侧栏前端。
- 技术栈（读 `package.json` 得到，非猜测）：
  - 构建：**WXT 0.19.x** + React 18 + TypeScript + Tailwind + antd
  - 模型接入：`ollama`、`openai`、`@langchain/openai`、`@modelcontextprotocol/sdk`（支持 MCP 工具）
  - 正文提取：**defuddle 0.18.1**（不是 Readability）
  - 存储：`dexie`（IndexedDB）+ `@plasmohq/storage`
  - 附件：`pdfjs-dist`（PDF 解析）、`tesseract.js`/`html2canvas`（截图层面的 OCR/截屏）
- **最有价值的一条**：它的 `package.json` 里直接给了 Edge 的构建/调试命令：

  ```json
  "dev:edge":   "cross-env TARGET=chrome wxt -b edge",
  "build:edge": "cross-env TARGET=chrome wxt build -b edge"
  ```

  也就是说：**Edge 用 Chromium 的构建产物，只是把浏览器目标换成 edge 来启动调试**。不用为 Edge 单独写一套。
- 抄袭点：WXT 的目录约定、侧栏与后台的职责划分、多 provider 的抽象层、defuddle 的用法。

### ChatGPTBox — 10,772 stars / MIT / JavaScript

- 仓库：https://github.com/ChatGPTBox-dev/chatGPTBox
- 定位：把 ChatGPT 深度塞进浏览器（划词、右键、侧栏、浮动球），支持 Chrome/Edge/Firefox/Safari。
- 技术栈：Preact 10.22（不用 React，体积小）+ 自写 webpack `build.mjs` + `@mozilla/readability 0.6.0`。
- 有意思的工程细节：仓库里有 `.github/workflows/scripts` 和 `scripts/submit-stores.mjs`、`scripts/check-edge-api-key.mjs`——**它把「提交 Edge 商店」也自动化了**，说明 Edge 上架有独立的 API Key/凭据流程。
- 抄袭点：Readability 的标准用法（克隆 document、剔除噪音节点）、划词菜单的交互、i18n 结构。

## 3. 第二梯队：小而完整，适合快速对照

| 项目 | 规模 | 说明 | 可借鉴 |
|---|---|---|---|
| [anantha037/ai-web-summarizer-sidepanel](https://github.com/anantha037/ai-web-summarizer-sidepanel) | 31 KB | MV3 侧栏 + 网页摘要 + 多轮上下文（自称 Mini-RAG），Gemini/Groq | 最小可跑通的分块检索思路，代码量小到能一口气读完 |
| [sinanisler/snn-chat](https://github.com/sinanisler/snn-chat) | 65 MB | 侧栏聊天、读页面内容、支持 OpenAI/OpenRouter、快捷键 | 最贴近「你想要的形态」的极简实现 |
| [Automacene/companion](https://github.com/Automacene/companion) | 746 KB | 侧栏聊天，对接本地 LLM 服务器与自定义 endpoint | 自定义 endpoint 的配置 UI |
| [opvelll/SidepanelLLM](https://github.com/opvelll/SidepanelLLM) | 已归档 | 早期 ChatGPT API 侧栏 | 反面教材：已停止维护，说明单 provider 绑定会死 |
| [beancookie/chrome-needle](https://github.com/beancookie/chrome-needle) | 16 MB | 45M 参数小模型直接跑在 WASM 里，完全离线 | 想「零联网」时的极端方案，暂不推荐 |

商业产品（不读代码，只当功能基准线）：**Sider、Monica、MaxAI、Harpa AI、ChatGPT Sidebar**，以及 Edge 自带的 Copilot 侧栏。它们的共同点：免费额度 + 订阅、划词即问、PDF/YouTube 摘要、多轮上下文。个人自用工具**没必要对齐它们的订阅体系**，重点对齐「划词即问」和「长文不崩」。

## 4. 官方文档事实（已核对原文，非推测）

来源：[Edge 侧栏开发文档](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/sidebar)、[Edge 支持的 API 列表](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support)、[Edge 上架流程](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension)。

- `sidePanel` API 在 Edge 中**受支持，且仅 MV3**（平台：Windows/Linux/Mac）。
- 三个必备零件：manifest 里 `"side_panel": { "default_path": "sidepanel.html" }`、`"permissions": ["sidePanel"]`、以及可选 `"action"` + `sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`。
- `sidePanel.open({ windowId | tabId })` **必须由用户手势触发**（点图标、右键菜单、快捷键、页面内按钮）。
- 侧栏是常驻的：切标签页不关；但 Edge 有一个已知问题——**切回「之前开过侧栏」的标签页时，侧栏不会自动重新显示**（microsoft/MicrosoftEdge-Extensions#142）。这点要在交互上兜住（例如提供快捷键/右键菜单/页面浮动按钮再次唤起）。
- 上架硬约束：MV3 强制、**禁止远程代码**（所以不能从 CDN 拉 SDK，必须打包进产物）、需声明「单一用途」、**逐项说明每个权限的理由**、收集数据则必须有隐私政策 URL、审核最长 7 个工作日。
- Edge Add-ons 不支持 Chrome Web Store 的支付体系（`identity.getAuthToken` 不被支持），所以别做内购。

## 4.5 补充核实：两个不在 GitHub 上的关键依赖（2026-11 从 npm registry 读到）

- **`ai`（Vercel AI SDK）= 7.0.162**，Apache-2.0，`engines.node >= 22`。keywords 含 `tool-calling`/`agent`/`agentic`/`mcp`。适配层是 `@ai-sdk/openai-compatible`，另有 `@ai-sdk/deepseek`、`@ai-sdk/moonshotai` 等官方包。
  → 结论：**流式 tool_call delta 拼装、多步续跑这类最容易写错的协议活，交给它**，不要手搓。注意是 v7，网上大量 v3/v4/v5 教程的 API 名（如 `maxSteps`）已变，以 ai-sdk.dev 当版本文档为准。
- **`@assistant-ui/react` = 0.15.32**，MIT，peer `react ^18 || ^19`，依赖 radix-ui / zustand / tailwind（shadcn 风格）。
  → 它是**整页聊天布局**取向，塞 400px 侧栏要重排；第一版不建议用，等需要工具调用可视化时再评估。

## 5. 从调研里提炼的五个判断

1. **不要自己写正文提取**。Readability（ChatGPTBox 用）和 Defuddle（Page Assist 用）都是成熟 MIT 库，自己写一定更差。
2. **不要绑定单一模型厂商**。`SidepanelLLM` 只接 ChatGPT 已归档；Page Assist 和 ChatGPTBox 都做成了多 provider。
3. **不要为 Edge 单独建项目**。WXT 一条命令切 target 即可。
4. **不要用远程 CDN**。MV3 + 商店审核双重禁止。
5. **不要做订阅/账号体系**。个人工具的最大优势是「Key 在我手里、内容不经过第三方服务器」，这也是唯一能打赢商业产品的点。

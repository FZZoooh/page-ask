# RightHandMan

*Right Hand Man — Manual on Your Right Hand*

简体中文 | [English](#english)

RightHandMan（旧称 PageAsk）是一款面向 Chromium 内核浏览器（Microsoft Edge / Google Chrome）的侧栏 AI 助手扩展。无需离开当前网页或阅读界面，即可一键解析当前标签页（支持普通网页与本地/在线 PDF）并向大语言模型提问。

---

## 核心特性

- **多格式内容提取**：自动提取普通网页正文；支持本地与在线 PDF 文档的文字解析。
- **划词引用问答**：支持在回答中选中文本进行二次引用提问。
- **系统托盘集成**：支持 Windows 系统托盘后台静默运行、进程守护及开机自启。
- **详细统计指标**：提供上下文 Token 计算、耗时监控及性能统计。

---

## 环境要求

- **操作系统**：Windows 10 1709（Fall Creators Update）或更高版本，建议 Windows 10 22H2 / Windows 11；系统托盘集成仅支持 Windows。
- **Node.js**：`≥ 22.13`（后端依赖原生 `node:sqlite` 及现代 PDF 解析能力）
- **包管理器**：`pnpm`
- **浏览器**：Microsoft Edge 或 Google Chrome（>= 116）

---

## 快速上手

### 1. 安装依赖并构建扩展

```powershell
pnpm install
pnpm build
```

构建完成后，扩展产物将输出至 `.output/chrome-mv3` 目录。

### 2. 启动本地服务

```powershell
pnpm tray:bg
# 后台运行；与终端分离 
```

> 服务默认监听 `127.0.0.1:8787`。首次启动会自动在 `%USERPROFILE%\.config\righthandman\` 下生成配置文件，所有配置都在这一个文件里。
>
> 配置文件中的 `port`、`dataDir`、`token` 分别控制端口、数据目录与访问令牌（`dataDir` 留空则使用默认值 `server/data`）。改这几个字段需要重启后端，或等待托盘每 4 秒自动重读文件并重启。

### 3. 配置 LLM 服务

1. 浏览器访问 **<http://127.0.0.1:8787/settings>**（或在系统托盘右键菜单中点击“配置”）。
2. 填写 Base URL、API Key 和模型名（仅支持 Responses API）。
3. 点击“保存”即可即时生效，无需重启后端。

“测试连接”会用当前表单里的地址、模型和 API Key（或已保存的 API Key，当该字段留空时）；点“清空 API Key”可删除已保存的 API Key。

> 如果配置文件里的 `token` 不为空，侧栏“设置”里的 **访问令牌** 必须填同一个值；`token` 为空时留空。

### 4. 安装侧栏扩展（Edge / Chrome）

1. 打开 Edge 并访问 `edge://extensions`；使用 Chrome 则访问 `chrome://extensions`。
2. 开启页面左侧的 **开发人员模式** 开关。
3. 点击 **加载解压缩的扩展**，选择项目根目录下的 `.output/chrome-mv3`。

---

## 使用说明

- **打开侧栏**：在任意网页或 PDF 阅读器中 **右键 → 选择“询问 RightHandMan”**，或直接点击浏览器工具栏的 RightHandMan 图标。
- **提问交互**：直接在输入框中提问即可；支持就当前视口和选中的文字（PDF 支持受限）提问，可引用回复。
- **附件**：点输入框左侧的 **+**，或把文件拖入 / 粘贴到输入区，即可附上图片、PDF、Word/Excel/PowerPoint（`.docx`/`.xlsx`/`.pptx`）和纯文本文件（每条消息最多 10 个，单个不超过 20 MB）。图片直接随消息发给模型，文档由模型按需读取；也可以只发附件不写文字。编辑消息时同样可以增删附件。粘贴的纯文本达到设置中的阈值（默认 10000 字节，按 UTF-8 计）时，会自动转为 `.txt` 附件，可在扩展设置里关闭或调整阈值。附件保存在后端，删除会话时一并删除。
- **系统托盘**：若使用 `pnpm tray:bg` 启动，系统托盘右键菜单提供服务启停、配置修改、开机自启切换以及日志查看等功能。

---

## 技术架构

| 模块           | 技术选型                  | 说明                                                                         |
| :------------- | :------------------------ | :--------------------------------------------------------------------------- |
| **前端扩展**   | WXT + React + TypeScript  | 采用 WXT 框架构建 Manifest V3 侧栏扩展；正文清洗基于 Defuddle。              |
| **后端服务**   | Node.js 原生运行时        | 核心采用 `node:http` 与原生 `node:sqlite` 构建，保持轻量与零额外运行时开销。 |
| **PDF 解析**   | `pdfjs-dist`              | 仅后端使用；扩展只负责取字节或交路径，文本层抽取在后端完成。                |
| **Office 解析** | `fflate`                 | 仅后端使用；解压 `.docx`/`.xlsx`/`.pptx` 并抽取文本供模型读取。             |
| **进程与托盘** | PowerShell / Windows Tray | 提供本地守护进程管理，异常崩溃自动恢复，支持随系统自启。                     |

---

## 文件存储

| 内容                          | 路径                                                |
| :---------------------------- | :-------------------------------------------------- |
| 基础配置（API Key、模型参数） | `%USERPROFILE%\.config\righthandman\settings.json`       |
| 本地数据（会话库/截图/附件/日志/运行标记） | `server\data\`（`righthandman.db`、`shots\`、`attachments\`、`*.log`、`run.json`） |
| 扩展构建产物                  | `.output\chrome-mv3\`                               |

> 注：配置目录与数据库已迁移为 `righthandman`（旧的 `.config\pageask` 会在首次启动时自动复制一份，确认无误后可手动删除）。日志文件名、浏览器存储键、`[pageask]` 日志前缀和环境变量仍沿用旧名，属于内部标识符。

---

## 常见问题 (FAQ)

**Q：侧栏提示“读不到这个页面”？**  
A：受限于浏览器安全策略，`edge://*` 内部页面及扩展商店不支持内容脚本注入，请在常规网页或 PDF 页面中使用。

**Q：本地 PDF（`file://`）无法解析？**  
A：由于浏览器扩展自身的沙盒权限限制，本地 PDF 由后端服务直接读取磁盘文件解析。请确保本地后端服务处于运行状态。

---

## 开发指南

```powershell
pnpm dev:edge     # 启动 Edge 开发调试模式（支持热重载）
pnpm compile      # 类型检查与语法校验
pnpm check:i18n   # 本地化守护（硬编码中文/错误码/locale/托盘 key）
pnpm test:server  # 后端独立测试套件
pnpm verify       # 提交前验证（本地化 + 编译 + 测试 + 构建）
```

---

<a id="english"></a>

## English

[简体中文](#righthandman) | English

RightHandMan (formerly PageAsk) is a side-panel AI assistant for Chromium-based browsers (Microsoft Edge and Google Chrome). Without leaving the current page or reading view, you can extract the active tab (regular web pages and local or online PDFs) in one click and ask a large language model about it.

---

### Features

- **Multi-format extraction**: pulls the main content out of ordinary web pages, and parses the text layer of both local and online PDF documents.
- **Ask about a selection**: select text in an answer to quote it in a follow-up question.
- **System tray integration**: runs quietly in the Windows tray, with a process watchdog and start-at-login support.
- **Detailed metrics**: context token counting, latency monitoring and performance statistics.

---

### Requirements

- **OS**: Windows 10 version 1709 (Fall Creators Update) or later; Windows 10 22H2 / Windows 11 recommended. The system tray integration is Windows-only.
- **Node.js**: `≥ 22.13` (the backend relies on native `node:sqlite` and modern PDF parsing)
- **Package manager**: `pnpm`
- **Browser**: Microsoft Edge or Google Chrome (with Developer mode enabled; the side panel API needs version 116+)

---

### Quick start

#### 1. Install dependencies and build the extension

```powershell
pnpm install
pnpm build
```

The build output goes to `.output/chrome-mv3`.

#### 2. Start the local service

```powershell
pnpm tray:bg
# runs in background; detached from terminal.
```

> The service listens on `127.0.0.1:8787` by default. The first start creates the config file under `%USERPROFILE%\.config\righthandman\`, and that one file holds the entire configuration.
>
> Its `port`, `dataDir` and `token` fields control the port, data directory and access token (`dataDir` empty means default value `server/data`). Changing these fields requires restarting the backend, or waiting for the tray to re-read the file every 4 seconds and restart automatically.

#### 3. Configure LLM service

1. Open **<http://127.0.0.1:8787/settings>** in the browser (or click "Configure" in the tray context menu).
2. Fill in the Base URL, API Key, and model name (Responses API only).
3. Click "Save" — it takes effect immediately, with no backend restart.

"Test connection" uses the URL, model, and API Key currently in the form (or the saved API Key when this field is left empty); click "Clear API Key" to delete the saved API Key.

> If `token` in the config file is non-empty, the **Access token** field in the panel's Settings must contain the same value; leave it empty when `token` is empty.

#### 4. Install the side-panel extension (Edge / Chrome)

1. Open `edge://extensions` in Edge, or `chrome://extensions` in Chrome.
2. Turn on **Developer mode** on the left side of the page.
3. Click **Load unpacked** and select `.output/chrome-mv3` in the project root.

---

### Usage

- **Open the panel**: on any web page or PDF viewer, **right-click → "Ask RightHandMan"**, or click the RightHandMan icon in the toolbar.
- **Asking questions**: simply type your question in the input box; supports asking about the current viewport and selected text (limited support for PDF), and quoting replies.
- **Attachments**: click the **+** at the left of the input, or drag / paste files into the composer, to attach images, PDFs, Word/Excel/PowerPoint (`.docx`/`.xlsx`/`.pptx`) and plain-text files (up to 10 per message, 20 MB each). Images go to the model with the message; documents are read by the model on demand. A message may carry attachments without any text, and editing a message can add or remove them too. Plain text pasted at or above the threshold (10000 UTF-8 bytes by default) becomes a `.txt` attachment; turn it off or change the threshold in the extension settings. The backend keeps a copy of each file and deletes it with the conversation.
- **System tray**: when started with `pnpm tray:bg`, the tray context menu offers service start/stop, configuration, start-at-login and log viewing.

---

### Architecture

| Module              | Technology                | Notes                                                                                       |
| :------------------ | :------------------------ | :------------------------------------------------------------------------------------------ |
| **Extension**       | WXT + React + TypeScript  | Manifest V3 side panel built with WXT; content cleanup is based on Defuddle.                |
| **Backend**         | Native Node.js runtime    | Built on `node:http` and native `node:sqlite`, keeping it lightweight with no extra runtime. |
| **PDF parsing**     | `pdfjs-dist`              | Backend only; the extension just supplies bytes or a path, text extraction happens server-side. |
| **Office parsing**  | `fflate`                  | Backend only; unzips `.docx`/`.xlsx`/`.pptx` and extracts their text for the model.         |
| **Process & tray**  | PowerShell / Windows Tray | Local daemon management, automatic recovery after crashes, and start-at-login.              |

---

### Where data lives

| Content                                        | Path                                                          |
| :--------------------------------------------- | :------------------------------------------------------------ |
| Base config (API key, model parameters)        | `%USERPROFILE%\.config\righthandman\settings.json`                 |
| Local data (conversations, screenshots, attachments, logs, run marker) | `server\data\` (`righthandman.db`, `shots\`, `attachments\`, `*.log`, `run.json`) |
| Extension build output                         | `.output\chrome-mv3\`                                         |

> Note: the config directory and database were migrated to `righthandman` (the old `.config\pageask` is copied on first start; delete it once verified). The log filename, browser storage keys, `[pageask]` log prefix and environment variable still use the old name — internal identifiers.

---

### FAQ

**Q: The panel says "can't read this page"?**  
A: Browser security policy prevents content-script injection into `edge://*` pages and the extension store. Use it on a regular web page or a PDF instead.

**Q: A local PDF (`file://`) won't parse?**  
A: Because of the extension's own sandbox restrictions, local PDFs are read from disk and parsed by the backend service. Make sure the local backend is running.

---

### Development

```powershell
pnpm dev:edge     # Edge dev mode with hot reload
pnpm compile      # type check + syntax check
pnpm check:i18n   # localization guard (hard-coded Chinese / error codes / locales / tray keys)
pnpm test:server  # backend test suite
pnpm verify       # pre-commit check (i18n + compile + tests + build)
```

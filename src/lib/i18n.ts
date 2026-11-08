/**
 * 面向用户的文案都在这里：key 用「模块.名字」命名，组件里只写 t('key')。
 * 语言在运行时选择（settings.locale / 浏览器语言）；新增语言就加一份字典并注册到 dictionaries，
 * 组件不用动，但两份字典的 key 必须完全一致（由 i18n.en-US.ts 的 satisfies 保证）。
 */
import { enUS } from './i18n.en-US';

export const zhCN = {

  // 顶栏
  'header.newChat': '新对话',
  'header.newChat.title': '开始新对话',
  'header.history': '历史',
  'header.history.title': '这一页的历史对话',
  'header.settings': '设置',
  'header.settings.title': '设置后端地址与模型',
  'header.reload': '重读',

  // 回答底部的小按钮
  'answer.copy': '复制',
  'answer.copied': '已复制',
  'answer.regenerate': '重新生成',
  'answer.regenerate.title': '重试（将覆盖）',

  // 历史列表
  'history.hint': '该站点的对话记录',
  'history.empty': '还没有记录',
  'history.untitled': '无标题',
  'history.count': ' 共 {count} 轮',
  'history.titleWithCount': '历史 {count}',
  'history.delete': '删除这段对话',
  'history.deleteConfirm': '删除这段对话？操作不可撤销',
  'history.loadEarlier': '加载更早的消息',
  'history.loadingEarlier': '正在加载…',
  // 时间显示：今天只显时间，昨天/周内/更早分别是「昨天」「周X」「月/日」
  'history.yesterday': '昨天',
  'weekday.0': '周日',
  'weekday.1': '周一',
  'weekday.2': '周二',
  'weekday.3': '周三',
  'weekday.4': '周四',
  'weekday.5': '周五',
  'weekday.6': '周六',

  // 页面卡片
  'page.text': '正文',
  'page.text.hide': '收起',
  'page.title.untitled': '无标题',
  'page.chars': '{count} 字',
  'page.tokens': '约 {count} tokens',
  'page.tookMS': '用时 {count} ms',
  'page.pdf': 'PDF {pages} 页',
  'page.longWarning': '全文较长，将分段读取',
  'page.text.title': '提取到的正文',
  'page.copy': '复制 Markdown',
  'page.copied': '已复制',
  'page.text.empty': '未提取到正文',

  // 读不到页面的各种原因
  'page.failure.title': '读不到这个页面',
  'page.failure.restricted':
    '浏览器内部页面由于安全限制，不允许扩展读取。换一个普通网页试试',
  'page.failure.permission':
    '未获得该页面的读取权限。刷新页面后重试；若仍失败，请在扩展详情页确认已允许访问该站点',
  'page.failure.empty': '页面返回了空内容，可能还在加载，或这是一个空白页',
  'page.failure.unknown': '读取失败',
  'page.failure.queryTabs': '查询标签页失败：{message}',
  'page.failure.noTab': '未找到当前标签页',
  'page.failure.noContent': '页面没有内容',
  'page.failure.blockedRaw':
    'Blocked by the browser: internal pages and the extension gallery cannot be scripted.',

  // PDF
  'page.failure.pdfNeedBackend': '请启动后端程序并重试',
  'page.failure.pdfTooBig': 'PDF 太大了（{size}），原始文件不应大于 {limit}',
  'page.failure.pdfNotPdf': '未获取到 PDF 文件，请检查是否发生跳转或需要登录',
  'page.failure.pdfParse': 'PDF 解析失败：{message}',
  'page.failure.pdfFetch': '下载 PDF 失败：{message}',
  'page.failure.pdfNoText':
    '此 PDF 没有可抽取的文字层',

  // 空状态
  'empty.ready': '就此页内容提问',
  'empty.notReady': '请先打开一个网页或 PDF 文件',
  'empty.suggestion.summary': '这一页讲了什么？',
  'empty.suggestion.threePoints': '用三点总结',
  'empty.suggestion.example': '文中的例子能再解释一下吗？',
  'empty.hasHistory': '此页有 {count} 段历史对话，从“历史”选项卡继续',

  // 工具步骤条（工具名由前端本地化，忽略后端 label）
  'tool.read_page': '读取页面',
  'tool.read_pdf': '读取 PDF',
  'tool.web_search': '联网搜索',
  'tool.fetch_url': '抓取网页',
  'tool.screenshot': '截图',
  'tool.unknown': '工具',
  'tool.detail.search': '搜索 {query}',
  'tool.detail.offset': '从第 {start} 字起',
  'tool.detail.full': '通读',
  'tool.detail.viewport': '当前可见区域',
  'tool.running': '进行中…',
  'tool.chars': '{count} 字',
  'tool.failed': '失败',

  // 一轮回答里折叠起来的「思考 + 工具调用」
  'round.running': '正在思考与调用工具…',
  'round.both': '调用了 {tools} 次工具，思考了 {secs} 秒',
  'round.toolsOnly': '调用了 {tools} 次工具',
  'round.thinkOnly': '思考了 {secs} 秒',

  // 回答
  'answer.usage': ' 输入 {in} tokens  输出 {out} tokens',
  'answer.stopped': '已停止生成',
  'answer.stoppedEmpty': '已停止',

  // 输入区
  'composer.placeholder.noSettings': '请先填写设置',
  'composer.placeholder.noPage': '当前页面无法读取',
  'composer.placeholder.ready': '给 PageAsk 发送消息',
  'composer.send': '发送',
  'composer.stop': '停止',
  // 输入框首行的网页选区提示（发送时会随请求带上）
  'composer.selection.aria': '网页选区：{text}',

  // 选中回答里的文字时弹出的快捷菜单
  'quote.action': '引用',
  'quote.action.title': '引用回答以追问',

  // 错误
  'error.unreachable': '连接后端 {baseUrl} 失败，请先启动后端',
  'error.streamCut': '后端连接中断，这条回答可能不完整',
  'error.backendStatus': '后端返回 {status}{detail}',
  'error.backendDetail': '：{detail}',
  'error.unknown': '未知错误',
  'error.historyLoad': '加载历史失败：{message}',
  'error.pageMismatch': '这个会话属于另一个页面',
  'error.historyDelete': '删除失败：{message}',
  'answer.copyFailed': '复制失败，请手动选中文字',

  // 后端错误码（与 server/errors.mjs 的 code 一一对应）
  'error.auth.origin': '请求来源不被允许',
  'error.auth.forbidden': '没有权限访问这个接口',
  'error.auth.bad_token': '访问令牌不正确',
  'error.request.bad_body': '请求体不合法，或超过了大小限制',
  'error.request.bad_host': '请求的主机名不被允许',
  'error.request.bad_id': '会话 ID 不合法',
  'error.request.missing_url': '缺少页面地址',
  'error.request.not_found': '接口不存在',
  'error.server.internal': '服务器内部错误',
  'error.conversation.not_found': '找不到这个会话',
  'error.conversation.busy': '这一轮还在生成，请稍后再试',
  'error.conversation.no_pending': '没有待恢复的提问',
  'error.settings.invalid_base_url': '上游地址要以 http:// 或 https:// 开头',
  'error.settings.invalid_state': '会话状态不合法（可选：{modes}）',
  'error.settings.missing_api_key':
    '还没有配置 API Key：打开 {settingsUrl} 填一个（或在托盘菜单里点「配置…」）',
  'error.settings.open_failed': '打不开配置文件，请手动打开它',
  'error.settings.test_failed': '测试连接失败',
  'error.chat.empty_text': '问题不能为空',
  'error.chat.missing_page': '缺少页面信息',
  'error.upstream.bad_request': '请求被上游拒绝（400）',
  'error.upstream.auth': 'API Key 无效或已过期',
  'error.upstream.balance': '账号余额不足',
  'error.upstream.model_not_found': '模型不存在，检查配置页里的默认模型',
  'error.upstream.invalid_request': '请求参数不合法（422）',
  'error.upstream.rate_limit': '请求过于频繁或超出配额',
  'error.upstream.empty': '上游没有返回任何内容',
  'error.upstream.timeout': '上游在 {seconds} 秒内没有响应',
  'error.upstream.status': '上游返回 {status}',
  'error.upstream.failed': '上游返回失败',
  'error.pdf.missing_source': '缺少 PDF 数据',
  'error.pdf.not_pdf': '不是 PDF 文件',
  'error.pdf.bad_file_url': '本地文件地址不合法',
  'error.pdf.not_found': '读不到这个本地文件',
  'error.pdf.not_file': '这个路径不是文件',
  'error.pdf.too_big': 'PDF 太大了，不应大于 64 MB',
  'error.pdf.bad': 'PDF 解析失败',
  'error.pdf.failed': 'PDF 解析失败',

  // 设置面板
  'settings.title': '设置',
  'settings.close': '收起',
  'settings.backendUrl': '后端地址',
  'settings.backendHint': '本地后端',
  'settings.invalidUrl': '无效的 URL',
  'settings.remoteHint': '非本机后端（{host}）：页面正文、选区和截图都会发到这台机器',
  'settings.remoteConfirm': '后端不在本机（{host}）。页面正文、选区和截图会离开这台电脑，仍然保存？',
  'settings.token': '访问令牌',
  'settings.tokenPlaceholder': '后端未设置 token 则留空',
  'settings.tokenHint': '需与后端配置文件中的 token 一致；仅保存在此浏览器中',
  'settings.save': '保存',
  'settings.saving': '保存中…',
  'settings.test': '测试连接',
  'settings.testing': '测试中…',
  'settings.verbose': '显示详细信息',
  'settings.verboseHint': '显示页面信息、思考过程、工具调用和用量统计',
  'answer.thinking': '正在思考',
  'answer.truncated': '本轮被中断，回答可能不完整',
  'settings.reset': '恢复默认',
  'settings.probeOk': '已连接到 {model}',
  'settings.console': '打开后端配置页',
  'settings.consoleHint': '配置 API 密钥、端点和模型名',
  'settings.language': '界面语言',
  'settings.languageAuto': '跟随浏览器',
  'settings.languageZh': '简体中文',
  'settings.languageEn': 'English',

  // 右键菜单
  'menu.askThisPage': '用 PageAsk 询问本页',
  'action.dismiss': '关闭提示',
} as const;

export type MessageKey = keyof typeof zhCN;

const dictionaries = { 'zh-CN': zhCN, 'en-US': enUS } as const;

export type Locale = keyof typeof dictionaries;

/** 设置里存的偏号：auto 跟随浏览器，其余强制指定 */
export type LocalePreference = 'auto' | Locale;

export const DEFAULT_LOCALE: Locale = 'zh-CN';

/** 浏览器语言是英文就用英文，其余一律中文；`zh` 与 `en` 都认 */
export function resolveLocale(pref: LocalePreference = 'auto'): Locale {
  if (pref !== 'auto') return pref;
  const tag = typeof navigator !== 'undefined' ? navigator.language : '';
  return /^en(?:-|$)/i.test(tag) ? 'en-US' : DEFAULT_LOCALE;
}

let current: Locale = resolveLocale('auto');

export function setLocale(locale: Locale): void {
  if (locale in dictionaries) current = locale;
}

export function getLocale(): Locale {
  return current;
}

/**
 * 取一条文案；`{name}` 用 vars 里的值替换。
 * 缺 key 时直接返回 key 本身，方便一眼看出漏翻的地方。
 */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const dict: Record<string, string> = dictionaries[current];
  const raw = dict[key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) =>
    vars[name] === undefined ? whole : String(vars[name]),
  );
}

/**
 * 把后端的错误码翻成本地文案；code 形如 `upstream.rate_limit`。
 * 没有对应 key 时退回后端给的 fallback，再退到「未知错误」。
 */
export function tError(
  code: string | undefined,
  params?: Record<string, string | number>,
  fallback?: string,
): string {
  if (!code) return fallback || t('error.unknown');
  const key = `error.${code}` as MessageKey;
  // 当前语言有这条错误就用当前语言；没有就退回后端给的 fallback
  if (Object.prototype.hasOwnProperty.call(dictionaries[current], key)) return t(key, params);
  return fallback || t('error.unknown');
}



/**
 * 面向用户的文案都在这里：key 用「模块.名字」命名，组件里只写 t('key')。
 * 加一种语言就复制一份字典，把 DEFAULT_LOCALE 改掉即可，组件不用动。
 */

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
  'answer.regenerate.title': '丢掉这条回答，重新问一遍',

  // 历史列表
  'history.hint': '该站点的对话记录',
  'history.empty': '还没有记录',
  'history.untitled': '无标题',
  'history.count': ' 共 {count} 轮',
  'history.titleWithCount': '历史 {count}',
  'history.delete': '删除这段对话',
  'history.deleteConfirm': '删除这段对话？操作不可撤销',
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
  'page.longWarning': '全文较长，模型按需分段读取',
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
  'page.failure.internalPage': '该页面属于浏览器内部页面或扩展商店，不允许扩展读取',
  'page.failure.noContent': '页面没有内容',
  'page.failure.blockedRaw':
    'Blocked by the browser: internal pages and the extension gallery cannot be scripted.',

  // PDF
  'page.failure.pdfNeedBackend': '请启动后端程序并重试',
  'page.failure.pdfFileAccess':
    '请到扩展详情页勾选“允许访问文件 URL”',
  'page.failure.pdfTooBig': 'PDF 太大了（{size}），不应大于 64 MB',
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
  'empty.hasHistory': '此页有 {count} 次历史对话，由“历史”选项卡继续',

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

  // 思考过程
  'think.streaming': '正在思考…',
  'think.done': '已思考 {count} 字',

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

  // 选中回答里的文字时弹出的快捷菜单
  'quote.action': '引用',
  'quote.action.title': '引用回答以追问',
  'quote.prefix': '针对上面这段：',
  'quote.remove': '移除这条引用',

  // 错误
  'error.unreachable': '连接后端 {baseUrl} 失败，请先启动后端',
  'error.streamCut': '后端连接中断，这条回答可能不完整',
  'error.backendStatus': '后端返回 {status}{detail}',
  'error.backendDetail': '：{detail}',
  'error.unknown': '未知错误',
  'error.conversationBusy': '请等待此轮对话结束',
  'error.historyLoad': '加载历史失败：{message}',
  'error.pageMismatch': '这个会话属于另一个页面',
  'error.historyDelete': '删除失败：{message}',
  'answer.copyFailed': '复制失败，请手动选中文字',

  // 设置面板
  'settings.title': '设置',
  'settings.close': '收起',
  'settings.backendUrl': '后端地址',
  'settings.backendHint': '本地后端',
  'settings.invalidUrl': '后端地址无效，请填 http://127.0.0.1:8787 这样的地址',
  'settings.remoteHint': '非本机后端（{host}）：页面正文、选区和截图都会发到这台机器',
  'settings.remoteConfirm': '后端不在本机（{host}）。页面正文、选区和截图会离开这台电脑，确定保存？',
  'settings.token': '访问令牌',
  'settings.tokenPlaceholder': '后端没设 PAGEASK_TOKEN 就留空',
  'settings.tokenHint': '需与后端环境变量 PAGEASK_TOKEN 一致；只存在本机浏览器里',
  'settings.save': '保存',
  'settings.saving': '保存中…',
  'settings.test': '测试连接',
  'settings.testing': '测试中…',
  'settings.verbose': '显示详细信息',
  'settings.verboseHint': '显示页面信息、思考过程、工具调用和统计',
  'answer.thinking': '正在思考',
  'answer.truncated': '本轮被中断，回答可能不完整',
  'settings.reset': '恢复默认',
  'settings.probeOk': '已连接到 {model}',
  'settings.console': '打开后端配置页',
  'settings.consoleHint': '配置 API 密钥、端点和模型名',

  // 右键菜单
  'menu.askThisPage': '用 PageAsk 询问本页',
  'action.dismiss': '关闭提示',
  'action.openPanel': '打开 PageAsk 侧栏',
} as const;

export type MessageKey = keyof typeof zhCN;

const dictionaries = { 'zh-CN': zhCN } as const;

export type Locale = keyof typeof dictionaries;

export const DEFAULT_LOCALE: Locale = 'zh-CN';

let current: Locale = DEFAULT_LOCALE;

export function setLocale(locale: Locale): void {
  current = locale;
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



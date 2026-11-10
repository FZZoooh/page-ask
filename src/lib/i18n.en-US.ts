/**
 * English (en-US) UI strings. Keys must match `zhCN` in `i18n.ts` exactly;
 * the `satisfies` clause below makes a missing or extra key a type error.
 */
import type { MessageKey } from './i18n';

export const enUS = {
  // Header
  'header.newChat': 'New chat',
  'header.newChat.title': 'Start a new chat',
  'header.history': 'History',
  'header.history.title': 'Chats on this page',
  'header.settings': 'Settings',
  'app.renderError': 'Something went wrong',
  'app.renderErrorHint': 'The side panel hit an unexpected error. Reload it to continue.',
  'app.reload': 'Reload',
  'header.settings.title': 'Configure backend and model',
  'header.reload': 'Reload',

  // Buttons under a question
  'question.copy': 'Copy',
  'question.copied': 'Copied',
  'question.edit': 'Edit this question',
  'question.edit.cancel': 'Cancel',
  'question.edit.send': 'Send',

  // Buttons under an answer
  'answer.copy': 'Copy',
  'answer.copied': 'Copied',
  'answer.regenerate': 'Regenerate',
  'answer.regenerate.title': 'Discard this answer and ask again',
  'scroll.toBottom': 'Scroll to bottom',

  // History list
  'history.hint': 'Chats on this site',
  'history.empty': 'No chats yet',
  'history.untitled': 'Untitled',
  'history.count': '· {count} turns',
  'history.titleWithCount': 'History {count}',
  'history.delete': 'Delete this chat',
  'history.deleteConfirm': 'Delete this chat? This cannot be undone.',
  'history.loadEarlier': 'Load earlier messages',
  'history.loadingEarlier': 'Loading…',
  'history.yesterday': 'Yesterday',
  'weekday.0': 'Sunday',
  'weekday.1': 'Monday',
  'weekday.2': 'Tuesday',
  'weekday.3': 'Wednesday',
  'weekday.4': 'Thursday',
  'weekday.5': 'Friday',
  'weekday.6': 'Saturday',

  // Page card
  'page.text': 'Content',
  'page.text.hide': 'Collapse',
  'page.title.untitled': 'Untitled',
  'page.chars': '{count} chars',
  'page.tokens': '~{count} tokens',
  'page.tookMS': '{count} ms',
  'page.pdf': 'PDF · {pages} pages',
  'page.longWarning': 'Long page — will be read in sections',
  'page.text.title': 'Extracted content',
  'page.copy': 'Copy Markdown',
  'page.copied': 'Copied',
  'page.text.empty': 'No content extracted',

  // Page read failures
  'page.failure.title': "Can't read this page",
  'page.failure.restricted':
    'Browser internal pages cannot be read by extensions for security reasons. Try a regular web page.',
  'page.failure.permission':
    'No permission to read this page. Refresh and try again; if it still fails, allow access to this site in the extension details.',
  'page.failure.empty': 'The page returned no content. It may still be loading, or it is a blank page.',
  'page.failure.unknown': 'Failed to read the page',
  'page.failure.queryTabs': 'Failed to query tabs: {message}',
  'page.failure.noTab': 'No active tab found',
  'page.failure.noContent': 'The page has no content',
  'page.failure.blockedRaw':
    'Blocked by the browser: internal pages and the extension gallery cannot be scripted.',

  // PDF
  'page.failure.pdfNeedBackend': 'Start the backend and try again',
  'page.failure.pdfTooBig': 'PDF is too large ({size}); the raw file limit is {limit}',
  'page.failure.pdfNotPdf': "Didn't get a PDF file. Check for a redirect or a login requirement.",
  'page.failure.pdfParse': 'Failed to parse PDF: {message}',
  'page.failure.pdfFetch': 'Failed to download PDF: {message}',
  'page.failure.pdfTimeout': 'Timed out downloading or parsing the PDF; try again',
  'page.failure.pdfNoText': 'This PDF has no extractable text layer',

  // Empty state
  'empty.ready': 'Ask about this page',
  'empty.notReady': 'Open a web page or PDF first',
  'empty.suggestion.summary': 'What is this page about?',
  'empty.suggestion.threePoints': 'Summarize in three points',
  'empty.suggestion.example': 'Can you explain the example in the text?',
  'empty.hasHistory': 'This page has {count} previous chats — continue from History',

  // Tool steps
  'tool.read_page': 'Read page',
  'tool.read_pdf': 'Read PDF',
  'tool.web_search': 'Web search',
  'tool.fetch_url': 'Fetch page',
  'tool.screenshot': 'Screenshot',
  'tool.unknown': 'Tool',
  'tool.detail.search': 'Search {query}',
  'tool.detail.offset': 'From character {start}',
  'tool.detail.full': 'Full text',
  'tool.detail.viewport': 'Visible area',
  'tool.running': 'Running…',
  'tool.chars': '{count} chars',
  'tool.failed': 'Failed',

  // Collapsed reasoning + tool calls
  'round.running': 'Thinking and calling tools…',
  'round.both': 'Thought for {secs}s · used {tools} tools',
  'round.toolsOnly': 'Used {tools} tools',
  'round.thinkOnly': 'Thought for {secs}s',

  // Answer
  'answer.usage': ' total {in} input tokens · {out} output tokens',
  'answer.stopped': 'Generation stopped',
  'answer.stoppedEmpty': 'Stopped',

  // Composer
  'composer.placeholder.noSettings': 'Configure settings first',
  'composer.placeholder.noPage': "This page can't be read",
  'composer.placeholder.ready': 'Message RightHandMan',
  'composer.send': 'Send',
  'composer.stop': 'Stop',
  'composer.inputAria': 'Message input',
  'composer.textOnly': 'Only plain text can be dropped',
  // Selection hint on the composer's first line (also sent with the request)
  'composer.selection.aria': 'Web page selection: {text}',

  // Quote popover
  'quote.action': 'Quote',
  'quote.action.title': 'Quote this answer in a follow-up',

  // Right-click menu on a formula
  'math.menu': 'Formula actions',
  'math.copy': 'Copy LaTeX',
  'math.copied': 'Copied',
  'math.quote': 'Quote',

  // Client-side errors
  'error.unreachable': 'Could not reach the backend at {baseUrl}. Start it first.',
  'error.streamCut': 'The backend connection dropped; this answer may be incomplete',
  'error.backendStatus': 'Backend returned {status}{detail}',
  'error.backendDetail': ': {detail}',
  'error.unknown': 'Unknown error',
  'error.historyLoad': 'Failed to load history: {message}',
  'error.historyUnavailable': 'History is temporarily unavailable; the current list was kept',
  'error.chat.nothing_to_regenerate': 'There is no question to regenerate',
  'error.chat.message_not_found': 'The question to edit was not found',
  'error.chat.invalid_edit': 'Editing and regenerating cannot be combined',
  'error.chat.invalid_page': 'Invalid page information',
  'error.upstream.bad_frame': 'The upstream returned unreadable data',
  'error.pageMismatch': 'This chat belongs to a different page',
  'error.historyDelete': 'Delete failed: {message}',
  'answer.copyFailed': 'Copy failed — select the text manually',

  // Backend error codes
  'error.auth.origin': 'Request origin is not allowed',
  'error.auth.forbidden': "You don't have permission to access this endpoint",
  'error.auth.bad_token': 'Access token is incorrect',
  'error.request.bad_body': 'Invalid request body, or it exceeds the size limit',
  'error.request.bad_host': 'Request host is not allowed',
  'error.request.bad_id': 'Invalid chat id',
  'error.request.missing_url': 'Missing page URL',
  'error.request.not_found': 'Endpoint not found',
  'error.server.internal': 'Internal server error',
  'error.conversation.not_found': 'Chat not found',
  'error.conversation.busy': 'This turn is still generating; try again later',
  'error.conversation.no_pending': 'No pending question to recover',
  'error.settings.invalid_base_url': 'Upstream URL must start with http:// or https://',
  'error.settings.invalid_state': 'Invalid session state (allowed: {modes})',
  'error.settings.missing_api_key':
    'No API key configured: open {settingsUrl} to add one (or choose "Configure…" from the tray menu)',
  'error.settings.open_failed': 'Could not open the config file; open it by hand',
  'error.settings.test_failed': 'Connection test failed',
  'error.chat.empty_text': 'Question cannot be empty',
  'error.chat.missing_page': 'Missing page information',
  'error.upstream.bad_request': 'Upstream rejected the request (400)',
  'error.upstream.auth': 'API key is invalid or expired',
  'error.upstream.balance': 'Insufficient account balance',
  'error.upstream.model_not_found': 'Model not found — check the default model in settings',
  'error.upstream.invalid_request': 'Invalid request parameters (422)',
  'error.upstream.rate_limit': 'Too many requests or quota exceeded',
  'error.upstream.empty': 'Upstream returned no content',
  'error.upstream.timeout': 'Upstream did not respond within {seconds}s',
  'error.upstream.status': 'Upstream returned {status}',
  'error.upstream.failed': 'Upstream request failed',
  'error.pdf.missing_source': 'Missing PDF data',
  'error.pdf.not_pdf': 'Not a PDF file',
  'error.pdf.bad_file_url': 'Invalid local file URL',
  'error.pdf.not_found': 'Cannot read this local file',
  'error.pdf.not_file': 'This path is not a file',
  'error.pdf.too_big': 'PDF is too large; the limit is 64 MB',
  'error.pdf.bad': 'Failed to parse PDF',
  'error.pdf.failed': 'Failed to parse PDF',

  // Settings panel
  'settings.title': 'Settings',
  'settings.close': 'Collapse',
  'settings.backendUrl': 'Backend URL',
  'settings.backendHint': 'Local backend',
  'settings.invalidUrl': 'Invalid backend URL',
  'settings.remoteHint':
    'Remote backend ({host}): page text, selections, and screenshots will be sent to that machine',
  'settings.remoteConfirm':
    'The backend is not on this machine ({host}). Page text, selections, and screenshots will leave this computer. Save anyway?',
  'settings.token': 'Access token',
  'settings.tokenPlaceholder': 'Leave blank if the backend has no token',
  'settings.tokenHint': "Must match the token in the backend's settings; stored only in this browser",
  'settings.save': 'Save',
  'settings.saving': 'Saving…',
  'settings.test': 'Test connection',
  'settings.testing': 'Testing…',
  'settings.verbose': 'Show details',
  'settings.verboseHint': 'Show page info, reasoning, tool calls, and usage',
  'answer.thinking': 'Thinking',
  'answer.truncated': 'This turn was interrupted; the answer may be incomplete',
  'settings.reset': 'Reset to defaults',
  'settings.probeOk': 'Connected to {model}',
  'settings.console': 'Open backend settings',
  'settings.consoleHint': 'Configure API key, endpoint, and model',
  'settings.language': 'Language',
  'settings.languageAuto': 'Auto (browser)',
  'settings.languageZh': '简体中文',
  'settings.languageEn': 'English',
  'settings.fontSize': 'Answer text size',
  'settings.fontSizeSmall': 'Small',
  'settings.fontSizeNormal': 'Default',
  'settings.fontSizeLarge': 'Large',
  'settings.fontSizeXLarge': 'Extra large',

  // Context menu
  'menu.askThisPage': 'Ask RightHandMan about this page',
  'action.dismiss': 'Dismiss',
} satisfies Record<MessageKey, string>;

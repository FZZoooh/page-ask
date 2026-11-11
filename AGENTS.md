# AGENTS.md

Project notes for AI collaborators (and humans) working in this repository. **Read this page before touching code**; the documentation map is in section 9.

## 1. What this is

RightHandMan: a Chromium side-panel extension (Microsoft Edge and Google Chrome, 116+) plus a local Node backend. The panel asks an OpenAI-compatible `/responses` endpoint questions about the **current tab** (web page / PDF).

Display name: RightHandMan (renamed from PageAsk). The config dir (`~/.config/righthandman`) and database file (`righthandman.db`) were migrated; other identifiers still say `pageask` on purpose — `pageask.settings.v2`, `pageask.log`, the `[pageask]` log prefix, `PAGEASK_ALLOW_REAL`, `/health/live`'s `app`, the tray mutex and `PageAsk Tray.lnk`. Do not "fix" those.

- Extension: WXT 0.21 + React 19 + TypeScript (strict), `src/`.
- Backend: `node server/index.mjs`, listening on `127.0.0.1:8787` by default (the `port` field in settings.json changes it). Routing and storage use Node built-ins only (`node:http`, `node:sqlite`); only PDF parsing pulls in the third-party `pdfjs-dist` (legacy build).
- The API key lives only in the backend at `~/.config/righthandman/settings.json`; the browser side never holds the key.
- Deliberately built for personal use and never published; `host_permissions: ['<all_urls>']` is intentional (see the comment in `wxt.config.ts`).

## 2. Environment and commands

| Command | What it does |
| --- | --- |
| `pnpm install` | Install dependencies (`postinstall` runs `wxt prepare`) |
| `pnpm dev:edge` | WXT dev server + launches Edge (`wxt -b edge`) |
| `pnpm build` | Production build → `.output/chrome-mv3` |
| `pnpm ext:key` | One-time: write `extension-key.json` (public, committed) + `~/.config/righthandman/extension-key.pem`; **changes the extension ID** |
| `pnpm ext:id` | Print the extension ID derived from `extension-key.json` |
| `pnpm compile` | `tsc --noEmit` + `scripts/check-syntax.mjs` (syntax check for `server/`, `scripts/` and `src/lib/` `.mjs`, plus UTF-8 BOM + PowerShell parser check for `.ps1`/`.psd1`), **must pass after every change** |
| `pnpm test:server` | Runs the 36 fixed backend regression scripts via `scripts/run-server-tests.mjs` (180s per script; temp dirs + fake upstream, never touches real config) |
| `pnpm verify` | `check:i18n` + `compile` + `test:server` + `build`; run this before committing |
| `pnpm server` | Start the backend in the foreground (`node server/index.mjs`) |
| `pnpm server:win` | Start the backend through the PowerShell script |
| `pnpm tray:bg` | WinForms tray + watchdog, runs resident in the background |

- The tray judges liveness by `/health/live` and reads the model/abnormal-exit state from the token-authenticated `/health`; when another program owns the port it shows "port in use" and pauses auto-restart; quitting the tray stops only the backend it started (an external `pnpm server` is left alone). The menu does a 50 ms loopback TCP precheck before the HTTP request, and only reports "backend recovered" after 8 s continuously down, so a quick restart is not mistaken for a crash.
- `node server/index.mjs --debug` turns on verbose diagnostics (`debugLog(scope, …)` in `server/log.mjs`): each record goes to stderr and `pageask.log`. It is a **logging switch, not a config override** — settings.json stays the only source of configuration. The first user is auto-title, which logs the full LLM request body and raw response (never the API key). Off by default; the regressions spawn without it.

- Node **≥ 22.13** (`node:sqlite` + pdfjs-dist 6.x); package manager is pnpm, and CI installs the exact version from `packageManager` in `package.json`.
- Windows 10 1709+ is the practical floor (Edge 116 and Node 22 both support it); the tray integration is Windows-only. `README.md` has the user-facing requirements section.
- There is a git repository and GitHub Actions (`.github/workflows/ci.yml`, windows-latest + Node 22.13 + `pnpm verify`); the remote is `origin` (GitHub) and workflows fire on push/PR; Dependabot opens dependency-update PRs weekly.
- After changing extension code, click "Reload" at `edge://extensions`; after changing the backend, restart the process; changing only `~/.config/righthandman/settings.json` needs no restart (the backend re-reads it on every request).
- `extension-key.json` pins the extension ID: it is a build property, not a per-machine setting. Replacing the key changes the ID, so it must be a deliberate act — afterwards reload the extension and restart the backend. Because dev and prod builds embed the same key, they now share one ID: only one of `.output/chrome-mv3` / `.output/chrome-mv3-dev` can be loaded at a time.
- The version number is maintained only in `package.json`; `wxt.config.ts` reads it through a JSON import. Never hand-write a second copy.

## 3. Layout

```
src/entrypoints/background.ts     service worker: sidePanel behavior, context menus
src/entrypoints/sidepanel/        side panel: App.tsx orchestrates the state machine;
                                  messages.ts is the pure message model; editorDom.ts adapts
                                  contenteditable; Composer/HistoryPanel/PageCard/RoundPanel/
                                  SettingsPanel are presentational components
src/lib/                          chat.ts / extract.ts / pdf.ts / settings.ts / i18n.ts / i18n.en-US.ts
src/components/                   MarkdownView.tsx, icons.tsx
server/                           backend: index.mjs routing + db/tools/pdf/text/log/webui/net/lifecycle/errors/upstream/extension-id
server/i18n/                      backend message dictionaries (zh-CN.mjs + en-US.mjs + en-XA pseudo-locale) and t()/negotiateLocale()
server/data/                      runtime artifacts (db, shots/, logs, run.json) — do not commit
scripts/                          PowerShell launcher/tray + fixed test runner + CDP/smoke scripts + ext-key/ext-id
test/                             manual-test fixtures (article.html, *.pdf)
docs/prior-art.md                 competitor research; docs/img/ holds version screenshots
PLAN.md                           archived early planning (unmaintained, not an implementation reference)
```

## 4. Data flow (understand this before changing either side)

1. Panel starts → `readActiveTab()`: for ordinary pages it injects `grabPage()` via `scripting.executeScript`, then extracts the main content with Defuddle; PDFs are fetched as bytes by the extension (with cookies) and sent to the backend via `POST /pdf` for parsing; restricted pages such as `edge://` and the extension store immediately report "can't read this page".
2. User sends → for web pages, if the page snapshot is older than 5 s the extension re-reads the body; it always re-reads the selection and viewport and captures the visible area → `POST /chat` (SSE stream).
3. The backend **does not stuff the page body into the system prompt**: the prompt stays static, and page metadata/selection travel as a per-turn `developer` message stored in the user row; the model reads the body on demand through tools: `read_page`, `screenshot`, `web_search`, `fetch_url`.
4. The tool loop has no step limit, but a single tool times out at 60s and 3 consecutive failures trip a breaker on the remaining tools; the user can stop at any time via "Stop" (`AbortController`); each assistant segment and tool result is persisted in one `addTurn()` transaction at the end of the round.
5. SSE events: `meta`, `reasoning`, `content`, `replace`, `usage`, `tool`, `done`, `error`, `title`. `replace` carries the authoritative final text when streamed deltas differ from the final output; the client must replace the current segment, never append it. `streamChat()` in `src/lib/chat.ts` reads `res.body` and parses the stream by hand. The panel groups each think/tool segment and the answer that follows into one phase.
6. Abnormal process exit: the backend writes `server/data/run.json` at startup (30s heartbeat + the OS uptime) and deletes it on clean exit. On Windows a shutdown/restart/logoff terminates a console process with no catchable signal (exit code `0x40010004`), so the tray answers `SystemEvents.SessionEnding` (`scripts/session-guard.ps1`, compiled C# because SystemEvents fires on a thread where a PowerShell script block has no runspace) and asks the backend to exit through `/api/shutdown` before Windows proceeds; if that loses the race, the tray treats `0x40010004` as "the session ended", removes the stale marker and does not restart, and `previousExitKind()` ignores a marker whose uptime is higher than the current one (proof the machine restarted). Only a same-boot leftover sets `/health.lifecycle.abnormalPreviousExit` and makes the tray warn; `/health.lifecycle.previousExit` says `clean` / `crash` / `osShutdown`. If the last row at crash time is an unanswered user message, the panel calls `POST /conversations/:id/recover` when loading the conversation, puts it back into the input box and deletes it from the database (an existing draft in the input box is not overwritten; recovery is deferred to the next load).

## 5. Hard constraints (violating these breaks things immediately)

**Security / networking**
- The backend binds to `127.0.0.1` only; never change it to `0.0.0.0`.
- CORS: anything other than no Origin (curl/scripts), same-origin `http://127.0.0.1:8787` / `http://localhost:8787` (the port follows settings.json), and `chrome-extension://<id>` (derived from `extension-key.json`; a missing key leaves the whitelist empty, so the backend fails closed instead of trusting an unknown origin) gets a 403.
- `/settings` and `/api/settings*` sit **before** token validation (the settings page must be able to recover itself); but `/api/settings*` accepts only same-origin requests or requests carrying the correct token. `GET /health/live` requires no auth and reports liveness only. `POST /api/settings/test` accepts a draft `baseUrl`; a blank `apiKey` uses the stored key, so a changed endpoint can be tested without retyping it. It returns only status/detail, never the upstream body.
- The key never enters the extension, never enters front-end `chrome.storage`, never lands in logs, and is never returned in plaintext (the settings page shows only `sk-554…f398`).
- URLs coming from the model or from web pages pass through `server/net.mjs` before any outbound request: public `http(s)` only; loopback/LAN/cloud-metadata addresses are rejected outright. Reads are capped by `content-length` + a streaming byte counter; never fall back to `arrayBuffer()` and check afterwards.

**Extension**
- `grabPage()` is serialized by `scripting.executeScript({func})` and injected into the page: it **must be fully self-contained** — no imports, no references to module-scope variables, no external helper functions.
- Opening the panel is delegated to `setPanelBehavior({ openPanelOnActionClick: true })`; inside `contextMenus.onClicked`, `sidePanel.open()` must be called **before the first await**, otherwise the user gesture is lost (`may only be called in response to a user gesture`).
- All user-facing strings live in `src/lib/i18n.ts` and `src/lib/i18n.en-US.ts` (`t('module.name')`); the two dictionaries must have identical keys (`satisfies Record<MessageKey, string>` is enforced by `tsc`), and components must not hard-code Chinese UI text.
- The UI language is stored in `settings.locale` (`auto` / `zh-CN` / `en-US`, default `auto` follows the browser); `resolveLocale()` resolves `auto` to a concrete locale, and after switching you must call `setLocale()` and re-render, keeping `<html lang>` in sync.
- Theming goes only through the CSS variables in `style.css` (`:root` + `prefers-color-scheme: dark`); never hard-code colors.
- The storage key is `pageask.settings.v2`; `backendUrl` is stripped of trailing slashes; conversation keys use the normalized URL (no `#hash`, tracking parameters such as `utm_*`/`fbclid` removed). An explicit non-default port is part of the key and of the page card's site label (`siteLabel()` uses `host`, not `hostname`), so `127.0.0.1:8811` and `127.0.0.1:9000` are two sites, never one history.
- The sync gate `sendingRef` in `App.tsx`, the 50ms batched setState for streaming tokens, and the contenteditable reference chips (serialized as `<q>…</q>`) are all fixes for bugs we already hit — do not simplify them away.
- A turn is rendered as phases: each think/tool segment plus the answer that follows. The `processMs` on every `content`/`replace` frame is server-authoritative; do not reintroduce a client-side phase timer or clear the centering lock on first content — those caused the 0.0 s and collapse-jump bugs.
- The bottom spacer / center-on-send scroll model is deliberate: the lead/spacer absorbs answer growth and think-block collapse, and `.list` sets `overflow-anchor: none`. The "scroll to bottom" button follows the real content bottom (`.list-end`), so it also appears when a growing answer passes the fold without any manual scroll, while the blank spacer below a centered question does not reveal it by itself. Do not replace the model with unconditional `scrollTop = scrollHeight`. An edited question reuses the spacer + 30 s lock but anchors at the scroll offset it had when Send was clicked (never re-centers): the rows the edit deletes would otherwise clamp the scroll and visibly move it.

**Backend**
- `server/settings.mjs` is the single source of truth for the whole configuration — `baseUrl` / `model` / `apiKey` / `state` plus `port`, `token`, `dataDir`; the file is re-read on every call and `dataDir` is resolved at import time (that is why tests set up their `settings.json` before importing server modules); in `writeSettings`, `apiKey === ''` means "leave unchanged". **No environment variable and no startup argument overrides the file** (to avoid "I changed the file but nothing happened"); a missing key is added back once at startup and the file is rewritten. The lone startup argument is `--debug`, which only toggles logging verbosity and never changes a config value (see §2). `port` / `token` / `dataDir` changes need a backend restart; the tray re-reads the file every 4s and restarts onto a new port by itself.
- The extension ID is **not** a setting: `server/extension-id.mjs` derives it from `extension-key.json` (SHA-256 of the DER, first 16 bytes, nibble → `a`..`p`), the same file `wxt.config.ts` puts in `manifest.key`. A legacy `extensionId` field left in `settings.json` is ignored with one log line and dropped on the next save. `pnpm ext:id` prints the ID; startup logs it and `/health` exposes `extensionId` + `extensionIdSource` (`extension-key.json` / `missing` / `invalid`).
- Tool results must be wrapped in `<untrusted_content source=...>` and hard-truncated (`RESULT_CAP = 8000`); a tool failure gives the model one short reason only, details go to `logError`, and upstream payloads are never exposed to the front end.
- Exit must go through `shutdown()` (`SIGINT/SIGTERM/SIGBREAK/SIGHUP` and `POST /api/shutdown`): delete `run.json`, close connections, `closeDb()`; never skip it with a bare `process.exit`, or WAL is not checkpointed and the next start falsely reports an abnormal exit. A Windows shutdown is not a signal a Node process can catch — do not "fix" that with a force-kill or by deleting `run.json` blindly; the tray guard and `previousExitKind()` handle it, and a marker may belong to another live instance.
- `addTurn()` writes assistant and tool rows in a single transaction; if the tool loop ends early, every unexecuted call must get a `<untrusted_content>` placeholder output, and `rowsToItems` skips calls without output on replay, to avoid a 400 from upstream.
- Schema changes add columns in place with `PRAGMA table_info` + `ALTER TABLE`; no destructive migrations. `messages.role` is only `user | assistant | tool`.
- Protocol changes must be made on both sides: SSE emits in `server/index.mjs` ↔ `ChatEvent` in `src/lib/chat.ts`; the `page` field ↔ `ChatRequest`.
- Error contract: HTTP 4xx/5xx and SSE `error` both go through `errorPayload()` / `UpstreamError` in `server/errors.mjs`; the body contains at least `code` (`domain.reason`) and optional `params`; `errorPayload` emits both `error` and `message` with the same localized fallback, while `code` stays authoritative. The front end maps `error.<code>` via `tError(code, params, message)`. Define the code first, then add the strings on both sides; tests assert `code`, never a Chinese sentence.
- Backend user-facing strings (settings page, error fallbacks) live in `server/i18n/zh-CN.mjs` and `server/i18n/en-US.mjs`: the settings page uses `t('webui.*')`, errors use `error.<code>`; `server/webui.mjs` contains no hard-coded Chinese. The settings page picks a dictionary from `?lang=` / `Accept-Language`, and the in-page language dropdown reloads with `?lang=`; available locales are `zh-CN`, `en-US` and the pseudo-locale `en-XA` (layout testing only, not a real language), and unknown languages fall back to the default. To add a locale, add a dictionary file and register it in `server/i18n/index.mjs`; the client script receives the whole dictionary.
- Tray strings live in `scripts/i18n/<culture>/Tray.psd1`; `scripts/tray.ps1` and `scripts/tray-bg.ps1` load them with `Import-LocalizedData` based on `$PSUICulture`: full culture first, then language prefix, then fall back to `en-US` / `zh-CN`. Scripts contain no user-visible Chinese (`Write-Tray` logs stay English).
- `scripts/check-i18n.mjs` is the localization guard, wired into `pnpm verify`: it scans quoted UI string literals and JSX text nodes for hard-coded Chinese (comments and `[pageask]` logs are exempt), works from any cwd, checks server/client error-code coverage, key alignment and pseudo-locale length across zh-CN/en-US/en-XA, and two-way consistency between the two tray dictionaries and `$script:Tray.*`.
- Key limits: `MAX_OUTPUT_TOKENS = 8192`, upstream timeout 300s, request body 4MB (`/pdf` 64MB), PDF 400 pages / 400k characters.
- `POST /pdf` with `fileUrl` may read any readable regular `.pdf` on disk (UNC/device paths are rejected, 64 MB cap); it stays token-gated. This is the deliberate personal-use boundary, not a sandbox for the backend user.
- Upstream uses the Responses API. `state=auto` enables `previous_response_id` only for known endpoints (`api.openai.com`, `*.openai.azure.com`, `*.services.ai.azure.com`); a broken chain is detected structurally by 400/404/409/422, falls back for the whole conversation, and is not retried again in this process. Do not switch back to Chat Completions. Reasoning items **must** be replayed on every `/chat` request because it always carries `tools`: DeepSeek thinking mode requires all historical reasoning content when `tools` is present, even for turns without a tool call, and returns 400 otherwise. Tool-less requests (auto-title) must not include reasoning. Send the plaintext reasoning content only; never send a real summary or `encrypted_content` (the empty `summary: []` is schema filler for OpenAI compatibility).

## 6. Code and commit style

- 2-space indent, single quotes, semicolons, trailing commas; line width ~120.
- **Write comments in English** (unless something explicitly requires otherwise). Comments **explain why** — pitfalls we hit, protocol limits, trade-offs — never "what this line does" filler. The localization dictionaries (`src/lib/i18n.ts`, `src/lib/i18n.en-US.ts`, `server/i18n/*.mjs`, `scripts/i18n/*/Tray.psd1`) are exempt: their content is the localized data itself.
- **Write commit messages in English** too — subject and body — keeping the conventional `type(scope): summary` prefix this history already uses (e.g. `feat(sidepanel): …`, `fix: …`, `chore: …`). Older commits are in Chinese; do not take them as the convention.
- **Start every independent task from a clean tree**: before editing anything for a new, unrelated request, run `git status`. If the previous task left uncommitted changes, commit them first (message rules above) so the new work cannot be mixed into that diff; do not include the new task's edits in that commit.
- Exported types/interfaces live in `src/lib/*.ts`, components only consume them; avoid `any` — `tsconfig` enables `strict` and `noUncheckedIndexedAccess`.
- Think before adding a dependency: the backend HTTP/DB layers must stay zero-dependency; PDF code uses `pdfjs-dist` only in `server/pdf.mjs`.

## 7. Verification

Run `pnpm verify` before committing (localization guard + types + syntax/BOM check of `.mjs` and PowerShell files + 34 backend regressions + build); CI runs the same command. There are still no front-end unit tests, so UI is covered by type checking + manual testing:

1. `pnpm verify` passes; for front-end-only changes, at least `pnpm compile` + `pnpm build`.
   Under the agent's Windows sandbox, `pnpm verify` can stop at `test-edge-profile.mjs` or `test-i18n-guard.mjs` with `EPERM` / `neither pwsh nor powershell is available`: `spawnSync` pipes are blocked there, not the assertions. Run the remaining scripts individually plus `pnpm build`, and re-run the two blocked checks by hand (`pwsh -File scripts/edge-test.ps1 -ValidateOnly` for `-ProfileName ci`, `..`, and the default; `node ../scripts/check-i18n.mjs` from `docs/`).
2. Backend changes: start the service with `pnpm server`, then `curl http://127.0.0.1:8787/health`; when needed use `node scripts/test-chat.mjs "question"` to watch SSE events (it reads port/token from settings.json). Manual probes that touch the real config/DB (`test-chat`, `test-cache`, `test-shot`, `test-pdf-prompt`, `test-selection-context`) refuse to run unless `PAGEASK_ALLOW_REAL=1`; the fixed regressions use a temporary `USERPROFILE` + a `settings.json` in it (see `scripts/temp-config.mjs`) and a fake upstream.
3. UI changes: run `pnpm build`, but **do not launch Edge or CDP from an agent session** — msedge.exe crashes under the sandbox and browser automation needs permissions the agent does not have. Write the manual steps for the user instead: reload `.output/chrome-mv3` at `edge://extensions`, serve `test/` on port 8811, open `127.0.0.1:8811/article.html`, exercise the change in light and dark, and state exactly what to look for. The `scripts/edge-test.ps1` + `cdp-eval.mjs` / `cdp-key.mjs` / `cdp-dark.mjs` helpers exist for a human to run.
4. Specialized scripts: `test-extension-id.mjs` (manifest key → ID known-answer test / fail-closed cases), `test-cache.mjs` (prefix caching), `test-shot.mjs` (screenshot persistence/replay), `test-pdf-prompt.mjs`, `test-selection-context.mjs`, `test-hist-time.mjs`, `test-turn-integrity.mjs` / `test-reasoning-replay.mjs` / `test-turn-abort.mjs` (tool rounds, reasoning replay and aborts), `test-empty-stream.mjs` (empty stream), `test-incomplete-and-bad-body.mjs` (truncated/bad requests), `test-lifecycle-recover.mjs` (abnormal exit / truncated-question recovery), `test-settings-webui.mjs` (settings-page strings/error codes/key clearing/token same-origin behavior). The fixed suite also includes `test-chat-edit.mjs` (edit a user message and regenerate from it), `test-page-context.mjs` (developer-role page context, cache-stable history, metadata deltas, edit refresh), `test-replace-sse.mjs` (replace event), `test-migration.mjs`, `test-cors-origin.mjs`, `test-pdf-cancel.mjs`, `test-upstream-error-cap.mjs`, `test-i18n-guard.mjs` and `test-edge-profile.mjs`; add new scripts to `scripts/run-server-tests.mjs`.
5. Record new decisions or pitfalls in `docs/` or the commit message; `PLAN.md` is archived — do not backfill it.

## 8. Dead ends (already disproved)

- Opening the panel with a keyboard shortcut (Alt+Shift is taken by the OS/IME); relying on `activeTab` alone; calling `sidePanel.open()` from the service worker outside a user gesture — it must stay synchronous inside the event handler (see §5 and `src/entrypoints/background.ts:41`).
- Pasting the whole page body into the system prompt (P3 moved to on-demand tool reads).
- Trying to fix "the panel disappears when switching tabs" — a known Edge defect (microsoft/MicrosoftEdge-Extensions#142).
- Overriding the configuration with environment variables or startup arguments (settings.json is the only source — see §5).
- Auto-summarizing the page: the model is only called when the user hits send.
- Fixing the think-block scroll jump with growth-only pinning, short suppression windows, or measuring the collapsing block before commit; all still moved the viewport. The bottom-spacer + center-lock model is the working solution (see §5).
- Launching Edge/CDP automatically from an agent session: msedge.exe crashed on startup (`APPCRASH … 0x80000003`) in both normal and headless modes, so UI verification is human-run (see §7.3).

## 9. Documentation map

- `README.md`: install, configure, use, FAQ (user-facing). It is bilingual — Simplified Chinese is the default, with an English section further down.
- `PLAN.md`: early planning and pitfall notes, **archived, unmaintained, not an implementation reference**; write new decisions in `docs/` or the commit message.
- `docs/prior-art.md`: competitor and technical-approach research.
- This file: the rules summary for collaborators; when it conflicts with the source, the source wins — and fix this file while you are there.

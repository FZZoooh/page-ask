// Throw-away config for tests.
//
// settings.json is the backend's only config source, so a test cannot steer it with environment
// variables anymore: it points USERPROFILE / HOME at a temporary home and writes the port, token,
// data dir and fake upstream into that home's settings.json. Nothing from the developer's real
// ~/.config/pageask/settings.json can leak in, and a test never touches real conversations.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_EXTENSION_ID = 'mmlkafokjmojbmebfofjaakibnmoikkm';

/**
 * Creates an isolated home with a settings.json and points USERPROFILE / HOME at it.
 * Call this before importing any server module: server/settings.mjs resolves the data dir at
 * import time.
 *
 * @param {object} [options]
 * @param {number} [options.port]         backend port the spawned server must use
 * @param {string} [options.token]        token the server requires on /health and /chat
 * @param {string} [options.dataDir]      absolute data dir; defaults to <root>/data
 * @param {string} [options.apiKey]       key the fake upstream expects
 * @param {string} [options.baseUrl]      fake upstream base URL
 * @param {string} [options.model]        model name reported by /health
 * @param {string} [options.state]        Responses API state mode
 * @returns {{root: string, home: string, dataDir: string, settingsFile: string, port: number, token: string, cleanup: () => void}}
 */
export function makeTestConfig(options = {}) {
  const {
    port = 8787,
    token = '',
    extensionId = DEFAULT_EXTENSION_ID,
    dataDir,
    apiKey = 'sk-test',
    baseUrl = 'http://127.0.0.1:1',
    model = 'test-model',
    state = 'auto',
  } = options;

  const root = mkdtempSync(join(tmpdir(), 'pageask-test-'));
  const home = join(root, 'home');
  const data = dataDir ?? join(root, 'data');
  const configDir = join(home, '.config', 'pageask');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(data, { recursive: true });

  const settingsFile = join(configDir, 'settings.json');
  const settings = { baseUrl, model, apiKey, state, port, token, extensionId, dataDir: data };
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);

  process.env.USERPROFILE = home;
  process.env.HOME = home;

  return {
    root,
    home,
    dataDir: data,
    settingsFile,
    port,
    token,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

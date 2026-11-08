// Print the extension ID implied by extension-key.json — the only origin the backend whitelists.
// Handy when a request 403s and you want to compare it with chrome://extensions.
import { EXTENSION_KEY_FILE, resolveExtensionId } from '../server/extension-id.mjs';

const { id, source } = resolveExtensionId();
if (!id) {
  const reason = source === 'missing' ? `${EXTENSION_KEY_FILE} is missing` : 'the key in it is invalid';
  console.error(`no extension id: ${reason}; run \`pnpm ext:key\` to create it`);
  process.exitCode = 1;
} else {
  console.log(id);
}

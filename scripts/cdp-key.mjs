// Send a real key press to the matching target (through Input.dispatchKeyEvent, same as a user press).
// Usage: node scripts/cdp-key.mjs <port> <URL substring> <key> [times]
// Example: node scripts/cdp-key.mjs 9373 sidepanel.html Backspace 1
import { connectCdp } from './cdp-client.mjs';

const [port = '9222', match = '', key = 'Backspace', times = '1'] = process.argv.slice(2);

const KEYS = {
  Backspace: { code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8, key: 'Backspace' },
  ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37, key: 'ArrowLeft' },
  ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39, key: 'ArrowRight' },
  Delete: { code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46, key: 'Delete' },
};

const spec = KEYS[key];
// Neither a preset key nor a single char -> error; a single char takes the char path (as if typed by hand)
const isChar = !spec && [...key].length === 1;
if (!spec && !isChar) {
  console.error('Unknown key: ' + key + '; use one of ' + Object.keys(KEYS).join(', ') + ', or one character');
  process.exit(1);
}

const cdp = await connectCdp(port, match);
const n = Math.max(1, Number(times) || 1);
for (let i = 0; i < n; i++) {
  if (isChar) {
    // Real character input: keyDown then insertText (equivalent to the user typing that character)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: key, key });
    await cdp.send('Input.insertText', { text: key });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key });
  } else {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...spec });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...spec });
  }
}
console.log(`Sent ${key} x ${n}`);
cdp.close();

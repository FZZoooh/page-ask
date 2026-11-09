// Switch the matching target to a given color-scheme preference, evaluate JS, optionally screenshot (all in
// one CDP session, because Emulation.setEmulatedMedia is session-scoped and is cleared when the session drops).
// Usage: node scripts/cdp-dark.mjs <port> <URL substring> <expression> [screenshot path] [light|dark]
import { writeFileSync } from 'node:fs';
import { connectCdp } from './cdp-client.mjs';

const [port = '9222', match = '', expr = '1+1', shotPath = '', scheme = 'dark'] = process.argv.slice(2);

const cdp = await connectCdp(port, match);
await cdp.send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-color-scheme', value: scheme }],
});

const r = await cdp.send('Runtime.evaluate', {
  expression: expr,
  awaitPromise: true,
  returnByValue: true,
  userGesture: true,
});
if (r.result?.exceptionDetails) {
  console.error('Exception:', r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
  process.exit(1);
}
const value = r.result?.result?.value;
console.log(typeof value === 'string' ? value : JSON.stringify(value));

if (shotPath) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  writeFileSync(shotPath, Buffer.from(shot.result.data, 'base64'));
  console.log('Screenshot: ' + shotPath);
}
cdp.close();

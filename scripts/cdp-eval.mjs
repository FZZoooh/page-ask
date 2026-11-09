// Generic CDP tool: evaluate a JS expression in the target whose URL matches.
// Usage: node scripts/cdp-eval.mjs <port> <URL substring> <expression>
// Example: node scripts/cdp-eval.mjs 9333 sidepanel.html "document.title"
import { connectCdp } from './cdp-client.mjs';

const [port = '9222', match = '', expr = '1+1'] = process.argv.slice(2);

const cdp = await connectCdp(port, match);
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
cdp.close();

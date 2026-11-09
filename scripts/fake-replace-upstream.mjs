// Fake Responses upstream for exercising the `replace` SSE event.
//
// It streams a few output_text deltas, then puts different text in response.completed. The backend
// must emit `replace` with the final text; the panel must show it once instead of appending it to the
// already streamed prefix.
//
// Manual use:
//   node scripts/fake-replace-upstream.mjs --port 8899
// Then set settings.json baseUrl to http://127.0.0.1:8899, restart the backend, and ask a question.
//
// The exported starter is also used by scripts/test-replace-sse.mjs.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const sse = (res, event, data) => {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

const readJson = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      // The real endpoint limits bodies; this fake only needs the stream flag.
      if (raw.length > 4 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });

/**
 * Start the fake upstream.
 * @param {{port?: number, streamed?: string, final?: string}} options
 */
export async function startFakeReplaceUpstream({ port = 0, streamed = 'AB', final = 'XY' } = {}) {
  let streamRequests = 0;

  const server = createServer(async (req, res) => {
    if (!req.url?.endsWith('/responses')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }

    const body = await readJson(req);

    // Auto-title uses a non-streaming request with the same endpoint; answer it so the panel does
    // not leave a pending title request behind.
    if (!body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'resp_title',
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'Replace SSE' }] }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
      return;
    }

    streamRequests += 1;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    for (const char of streamed) {
      sse(res, 'response.output_text.delta', { type: 'response.output_text.delta', delta: char });
    }

    // The final output intentionally disagrees with the deltas: "AB" then "XY".
    sse(res, 'response.completed', {
      type: 'response.completed',
      response: {
        id: `resp_replace_${streamRequests}`,
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: final }] }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    res.end();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    server,
    port: server.address().port,
    url: `http://127.0.0.1:${server.address().port}`,
    get streamRequests() {
      return streamRequests;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const portAt = args.indexOf('--port');
  const port = portAt >= 0 ? Number(args[portAt + 1]) : 8899;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('Usage: node scripts/fake-replace-upstream.mjs [--port 8899]');
    process.exit(2);
  }

  const fake = await startFakeReplaceUpstream({ port });
  console.log(`fake replace upstream listening on ${fake.url}`);
  console.log('Streams "AB", then completes with "XY" so /chat emits event: replace.');
  console.log('');
  console.log('Point the backend at it:');
  console.log(`  baseUrl = ${fake.url}`);
  console.log('  apiKey  = any non-empty value');
  console.log('  state   = off');
  console.log('Then restart the backend and ask a question. Expect "XY" exactly once.');
  console.log('Press Ctrl+C to stop.');

  const stop = async () => {
    await fake.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

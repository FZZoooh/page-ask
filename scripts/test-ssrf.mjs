// Regression: the outbound boundary must reject direct private addresses (including numeric IPv4
// and IPv4-mapped IPv6 spellings), private DNS answers, and redirects that leave the public internet.
// Run: node scripts/test-ssrf.mjs
import { assertPublicHttpUrl, fetchPublic, isPrivateHost } from '../server/net.mjs';

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !extra ? '' : ` — ${extra}`}`);
  if (!ok) failures += 1;
};

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const privateLookup = async () => [{ address: '127.0.0.1', family: 4 }];
const mixedLookup = async () => [
  { address: '93.184.216.34', family: 4 },
  { address: '10.0.0.7', family: 4 },
];

for (const host of [
  '127.0.0.1',
  '127.1',
  '2130706433',
  '0x7f000001',
  '0177.0.0.1',
  '169.254.169.254',
  '10.0.0.1',
  '192.168.1.1',
  '[::1]',
  '[::ffff:7f00:1]',
  '[::ffff:127.0.0.1]',
  '[::ffff:0:7f00:1]',
  '[64:ff9b::7f00:1]',
  '[2002:7f00:1::]',
  '[fe80::1]',
  '[fc00::1]',
  '[2001:db8::1]',
]) {
  check(`isPrivateHost rejects ${host}`, isPrivateHost(host));
}

for (const host of ['8.8.8.8', '1.1.1.1', '93.184.216.34', 'example.com', '[2001:4860:4860::8888]']) {
  check(`isPrivateHost allows ${host}`, !isPrivateHost(host));
}

const rejects = async (name, raw, options) => {
  let error;
  try {
    await assertPublicHttpUrl(raw, options);
  } catch (err) {
    error = err;
  }
  check(name, Boolean(error), error ? '' : 'URL was accepted');
};

await rejects('rejects loopback literal', 'http://127.0.0.1/');
await rejects('rejects short IPv4 literal', 'http://127.1/');
await rejects('rejects numeric IPv4 literal', 'http://2130706433/');
await rejects('rejects hex IPv4 literal', 'http://0x7f000001/');
await rejects('rejects IPv4-mapped IPv6', 'http://[::ffff:7f00:1]/');
await rejects('rejects private DNS answer', 'https://internal.example/', { lookup: privateLookup });
await rejects('rejects mixed DNS answers', 'https://mixed.example/', { lookup: mixedLookup });
await rejects('rejects DNS failure', 'https://missing.example/', {
  lookup: async () => {
    throw new Error('no such host');
  },
});
await rejects('rejects private DNS rebinding name', 'https://127.0.0.1.nip.io/', { lookup: privateLookup });
await rejects('rejects credentials', 'https://user:pass@example.com/', { lookup: publicLookup });
await rejects('rejects non-http schemes', 'file:///etc/passwd');

let accepted;
try {
  accepted = await assertPublicHttpUrl('https://example.com/a', { lookup: publicLookup });
} catch (err) {
  accepted = null;
}
check('accepts a public name', accepted?.href === 'https://example.com/a', String(accepted));

let redirectCalls = 0;
let redirectError;
try {
  await fetchPublic(
    'https://public.example/start',
    {},
    {
      lookup: publicLookup,
      fetch: async () => {
        redirectCalls += 1;
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } });
      },
    },
  );
} catch (err) {
  redirectError = err;
}
check('redirect to loopback is rejected before it is fetched', Boolean(redirectError) && redirectCalls === 1);

let dnsRedirectError;
try {
  await fetchPublic(
    'https://public.example/start',
    {},
    {
      lookup: async (host) => [
        { address: host === 'evil.example' ? '127.0.0.1' : '93.184.216.34', family: 4 },
      ],
      fetch: async () =>
        new Response(null, { status: 302, headers: { location: 'https://evil.example/secret' } }),
    },
  );
} catch (err) {
  dnsRedirectError = err;
}
check('redirect target is resolved and rejected when private', Boolean(dnsRedirectError));

let followUrls = [];
let followed;
try {
  followed = await fetchPublic(
    'https://public.example/start',
    {},
    {
      lookup: publicLookup,
      fetch: async (url) => {
        followUrls.push(String(url));
        if (followUrls.length === 1) {
          return new Response(null, { status: 302, headers: { location: '/next' } });
        }
        return new Response('ok', { status: 200 });
      },
    },
  );
} catch {
  followed = null;
}
check(
  'relative public redirect is followed',
  followed?.status === 200 && followUrls.length === 2 && followUrls[1] === 'https://public.example/next',
  followUrls.join(' -> '),
);

let loopError;
let loopCalls = 0;
try {
  await fetchPublic(
    'https://public.example/loop',
    {},
    {
      lookup: publicLookup,
      fetch: async () => {
        loopCalls += 1;
        return new Response(null, { status: 302, headers: { location: '/loop' } });
      },
    },
  );
} catch (err) {
  loopError = err;
}
check('redirect loop stops at the hop limit', Boolean(loopError) && loopCalls <= 6, `calls=${loopCalls}`);

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exitCode = failures ? 1 : 0;

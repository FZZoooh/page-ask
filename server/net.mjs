/**
 * Outbound fetch boundary: public http(s) only, plus a size cap on reads.
 *
 * Every redirect is validated and every hostname is resolved before the request; all resolved
 * addresses must be public. A determined attacker can still win a DNS-rebinding race between this
 * lookup and fetch's own connection, but the direct-address and redirect cases are closed here.
 * baseUrl (user-set) is exempt.
 */
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/** hostnames that clearly belong to this machine / LAN / reserved ranges */
export function isPrivateHost(hostname) {
  const host = bareHost(hostname);
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true;

  const v4 = parseIPv4Loose(host);
  if (v4 !== null) return isPrivateIPv4Value(v4);
  if (isIP(host) === 6) return isPrivateIPv6(host);
  return false;
}

function bareHost(hostname) {
  let host = String(hostname ?? '').trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return host.replace(/\.$/, '');
}

/**
 * Parse the non-canonical IPv4 forms that inet_aton and browsers accept (`127.1`,
 * `2130706433`, `0x7f000001`, `0177.0.0.1`). isIP only accepts dotted decimals, so without
 * this a numeric hostname slips past the direct-address check.
 */
function parseIPv4Loose(host) {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const nums = [];
  for (const part of parts) {
    if (!part) return null;
    let value;
    if (/^0x[0-9a-f]+$/i.test(part)) value = Number.parseInt(part.slice(2), 16);
    else if (/^0[0-7]+$/.test(part)) value = Number.parseInt(part, 8);
    else if (/^\d+$/.test(part)) value = Number(part);
    else return null;
    if (!Number.isSafeInteger(value) || value < 0) return null;
    nums.push(value);
  }
  for (let i = 0; i < nums.length - 1; i += 1) {
    if (nums[i] > 255) return null;
  }
  const lastBits = 8 * (5 - nums.length);
  if (nums[nums.length - 1] >= 2 ** lastBits) return null;

  let value = 0;
  for (let i = 0; i < nums.length - 1; i += 1) value = (value << 8) | nums[i];
  value = (value * 2 ** lastBits + nums[nums.length - 1]) >>> 0;
  return value;
}

function isPrivateIPv4Value(value) {
  const ip = `${(value >>> 24) & 255}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`;
  return isPrivateIPv4(ip);
}

function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
  if (p[0] === 169 && p[1] === 254) return true; // link-local / cloud metadata
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 192 && p[1] === 0 && (p[2] === 0 || p[2] === 2)) return true;
  if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return true;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
  if (p[0] >= 224) return true; // multicast / reserved
  return false;
}

/** Parse any IPv6 spelling to eight 16-bit words; null when invalid. */
function parseIPv6(ip) {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);

  if (s.includes('.')) {
    const idx = s.lastIndexOf(':');
    const v4 = s.slice(idx + 1);
    const p = v4.split('.').map(Number);
    if (idx === -1 || p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    s = `${s.slice(0, idx + 1)}${(((p[0] << 8) | p[1]) >>> 0).toString(16)}:${(((p[2] << 8) | p[3]) >>> 0).toString(16)}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part) =>
    part
      ? part.split(':').map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : NaN))
      : [];
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if ([...head, ...tail].some(Number.isNaN)) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...Array(fill).fill(0), ...tail];
}

function isPrivateIPv6(ip) {
  const w = parseIPv6(ip);
  if (!w) return true;

  const v4 = (hi, lo) => `${(hi >>> 8) & 255}.${hi & 255}.${(lo >>> 8) & 255}.${lo & 255}`;
  // ::/64 covers IPv4-compatible, IPv4-mapped and IPv4-translated spellings; none of them should
  // hide a private address in the low 32 bits.
  if (w.slice(0, 4).every((n) => n === 0) && isPrivateIPv4(v4(w[6], w[7]))) return true;

  // ::/96 (IPv4-compatible) is deprecated; reject the whole range instead of enumerating its
  // historical spellings.
  if (w.slice(0, 6).every((n) => n === 0)) return true;
  if ((w[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((w[0] & 0xffc0) === 0xfec0) return true; // deprecated site-local fec0::/10
  if ((w[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((w[0] & 0xff00) === 0xff00) return true; // multicast
  if (w[0] === 0x2001 && w[1] === 0x0db8) return true; // documentation
  if (w[0] === 0x0064 && w[1] === 0xff9b) return isPrivateIPv4(v4(w[6], w[7])); // NAT64
  if (w[0] === 0x2002) return isPrivateIPv4(v4(w[1], w[2])); // 6to4 embeds an IPv4 address
  return false;
}

const dnsLookupAll = (host) => dnsLookup(host, { all: true, verbatim: true });

/**
 * Validate a user-/model-supplied URL; throw if invalid (the caller decides how to present it).
 * `lookup` is injectable so tests can avoid real DNS.
 */
export async function assertPublicHttpUrl(raw, { lookup = dnsLookupAll } = {}) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http/https URLs are supported');
  if (url.username || url.password) throw new Error('URL must not contain a username or password');

  const host = bareHost(url.hostname);
  if (isPrivateHost(host)) throw new Error('Local or private addresses are not allowed');
  if (isIP(host) || parseIPv4Loose(host) !== null) return url;

  let records;
  try {
    records = await lookup(host);
  } catch {
    // Fail closed: an unresolvable name must not fall through to fetch's own lookup.
    throw new Error('Cannot resolve this domain');
  }
  const list = Array.isArray(records) ? records : [records];
  if (list.length === 0) throw new Error('Cannot resolve this domain');
  for (const record of list) {
    const address = typeof record === 'string' ? record : record?.address;
    if (!address || !isIP(address) || isPrivateHost(address)) throw new Error('Local or private addresses are not allowed');
  }
  return url;
}

/**
 * fetch() with every redirect target validated before it is requested. A plain
 * `redirect: 'follow'` would let a public URL bounce to 127.0.0.1 or the metadata endpoint after
 * the only check.
 */
export async function fetchPublic(raw, init = {}, options = {}) {
  const fetchImpl = options.fetch ?? fetch;
  let url = await assertPublicHttpUrl(raw, options);

  for (let redirects = 0; ; redirects += 1) {
    const res = await fetchImpl(url, { ...init, redirect: 'manual' });
    if (!REDIRECT_STATUS.has(res.status)) return res;

    const location = res.headers.get('location');
    if (!location) return res;
    await discardBody(res);
    if (redirects >= MAX_REDIRECTS) throw new Error('Too many redirects');

    const next = new URL(location, url);
    await assertPublicHttpUrl(next.href, options);
    url = next;
  }
}

async function discardBody(res) {
  try {
    await res.body?.cancel();
  } catch {
    /* the next hop is what matters */
  }
}

/** read the body up to a cap; cancel the stream and throw past it — never arrayBuffer first, check later */
export async function readBodyCapped(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`Response exceeds ${Math.round(maxBytes / 1024 / 1024)} MB limit`);
  }
  if (!res.body) return Buffer.alloc(0);

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`Response exceeds ${Math.round(maxBytes / 1024 / 1024)} MB limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks);
}

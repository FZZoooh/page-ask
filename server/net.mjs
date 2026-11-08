/**
 * Outbound fetch boundary: public http(s) only, plus a size cap on reads.
 *
 * Deliberately no DNS resolution: TOCTOU remains between the lookup and fetch's actual
 * connection; this layer mainly blocks the direct-address case — a model lured by page content
 * into reading localhost / LAN / cloud metadata. baseUrl (user-set) is exempt.
 */
import { isIP } from 'node:net';

/** hostnames that clearly belong to this machine / LAN / reserved ranges */
export function isPrivateHost(hostname) {
  let host = String(hostname ?? '').trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true;

  const version = isIP(host);
  if (version === 4) return isPrivateIPv4(host);
  if (version === 6) return isPrivateIPv6(host);
  return false;
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

function isPrivateIPv6(ip) {
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  if (v.startsWith('fe80')) return true; // link-local
  if (/^f[cd]/.test(v)) return true; // unique local
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

/** validate a user-/model-supplied URL; throw if invalid (the caller decides how to present it) */
export function assertPublicHttpUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error('链接格式不对');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('只支持 http/https 链接');
  if (url.username || url.password) throw new Error('链接里不能带用户名或密码');
  if (isPrivateHost(url.hostname)) throw new Error('不允许访问本机或内网地址');
  return url;
}

/** read the body up to a cap; cancel the stream and throw past it — never arrayBuffer first, check later */
export async function readBodyCapped(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`响应超过 ${Math.round(maxBytes / 1024 / 1024)} MB 上限`);
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
        throw new Error(`响应超过 ${Math.round(maxBytes / 1024 / 1024)} MB 上限`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks);
}

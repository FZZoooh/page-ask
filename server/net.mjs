/**
 * 出站抓取的边界：只允许公网 http(s)，并给读取加大小上限。
 *
 * 这里刻意不做 DNS 解析：解析结果和 fetch 实际连接之间仍有 TOCTOU，
 * 而这一层主要是挡住「模型被网页内容诱导去读 localhost / 内网 / 云元数据」
 * 这类直给地址；真正连不接受信任目标的是 baseUrl（用户自己配的，放行）。
 */
import { isIP } from 'node:net';

/** 明显属于本机/内网/保留地址的主机名 */
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
  if (p[0] === 169 && p[1] === 254) return true; // link-local / 云元数据
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 192 && p[1] === 0 && (p[2] === 0 || p[2] === 2)) return true;
  if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return true;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
  if (p[0] >= 224) return true; // 组播/保留
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

/** 校验一个「用户/模型给的」URL；不合法就抛错（调用方决定怎么呈现） */
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

/** 按上限读取响应体；超限就取消流并抛错，避免先 arrayBuffer 再检查 */
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

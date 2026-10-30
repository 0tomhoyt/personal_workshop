// 电视监听的网络小工具：地址归一、CIDR 解析与匹配、Host 反 rebinding。
// 单独成模块，是因为 config.mjs（校验用户写的 allowedCidrs）与 tv-server.mjs（请求时匹配）
// 都要用同一套解析——放在任一侧都会循环 import，而两套实现迟早会不一致。
// 全是纯函数，便于单测。

const CIDR_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}|[0-9a-fA-F:.]+\/\d{1,3})$/;

/** 形态上像个 CIDR（粗筛，给配置层用；真正的合法性看 [parseCidr]）。 */
export const looksLikeCidr = (v) => CIDR_RE.test(String(v ?? '').trim());

/** Node 把 IPv4 客户端报成 ::ffff:a.b.c.d；先归一成点分四段。 */
export function normalizeAddress(raw) {
  const s = String(raw || '').trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  return mapped ? mapped[1] : s;
}

function ipv4ToBigInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n << 8n) | BigInt(v);
  }
  return n;
}

function ipv6ToBigInt(ip) {
  if (!ip.includes(':')) return null;
  // 处理 :: 缩写；内嵌 IPv4 尾巴（::ffff:1.2.3.4）先换回两组十六进制
  let s = ip.replace(/%.*$/, '');
  const v4tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4tail) {
    const v = ipv4ToBigInt(v4tail[1]);
    if (v === null) return null;
    s = s.slice(0, v4tail.index) + `${(v >> 16n).toString(16)}:${(v & 0xffffn).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part) => (part ? part.split(':').filter(Boolean).map((g) => {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) throw new Error('bad group');
    return parseInt(g, 16);
  }) : []);
  let groups;
  try {
    if (halves.length === 2) {
      const head = parse(halves[0]);
      const tail = parse(halves[1]);
      const fill = 8 - head.length - tail.length;
      if (fill < 0) return null;
      groups = [...head, ...Array(fill).fill(0), ...tail];
    } else {
      groups = parse(s);
    }
  } catch { return null; }
  if (groups.length !== 8) return null;
  return groups.reduce((n, g) => (n << 16n) | BigInt(g), 0n);
}

/** CIDR → { value, bits, width }；非法（越界 octet、bits 越界、坏分组）返回 null。 */
export function parseCidr(cidr) {
  const [ip, bitsRaw] = String(cidr).split('/');
  const bits = Number(bitsRaw);
  const v4 = ipv4ToBigInt(ip);
  if (v4 !== null && Number.isInteger(bits) && bits >= 0 && bits <= 32) {
    return { value: v4, bits, width: 32 };
  }
  const v6 = ipv6ToBigInt(ip);
  if (v6 !== null && Number.isInteger(bits) && bits >= 0 && bits <= 128) {
    return { value: v6, bits, width: 128 };
  }
  return null;
}

/** [address] 是否落在 [cidrs] 之一。解析不了的地址/网段一律不匹配（默认拒绝）。 */
export function inCidrs(address, cidrs) {
  const ip = normalizeAddress(address);
  const v4 = ipv4ToBigInt(ip);
  const v6 = v4 === null ? ipv6ToBigInt(ip) : null;
  if (v4 === null && v6 === null) return false;
  for (const c of Array.isArray(cidrs) ? cidrs : []) {
    const net = parseCidr(c);
    if (!net) continue;
    const mine = net.width === 32 ? v4 : v6;
    if (mine === null) continue;
    const shift = BigInt(net.width - net.bits);
    if ((mine >> shift) === (net.value >> shift)) return true;
  }
  return false;
}

/**
 * DNS rebinding 防护：只接受 IP 字面量与局域网名字。攻击者的域名解析到本机 LAN
 * 地址时，浏览器发来的 Host 是他的域名——与 /admin/* 的回环校验同一威胁模型。
 */
export function hostAllowed(hostHeader) {
  const host = String(hostHeader || '').trim().toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (!host) return false;
  if (ipv4ToBigInt(host) !== null || ipv6ToBigInt(host) !== null) return true;
  return host === 'localhost' || host.endsWith('.local');
}

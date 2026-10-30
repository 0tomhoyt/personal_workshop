// 网关侧客户端鉴权：/v1/* 请求必须携带 providers.json 里 gateway.clientToken
// 签发的 Bearer token（也接受 x-api-key 头）。admin/healthz 仍只靠 127.0.0.1 绑定保护。
//
// 防护边界（如实说明）：单用户 Mac 上其他进程与网关同 uid，理论上仍可读到
// providers.json 或 /admin/config 里的 token；此层挡的是「盲用 127.0.0.1:8484 的
// 无凭证请求」与「误把端口暴露出去后的外部扫探」。
import { timingSafeEqual } from 'node:crypto';
import { getConfig } from './config.mjs';
import { httpError } from './util.mjs';

// 导出给 TV token 校验（lib/tv-server.mjs）共用：同一套「长度不同也耗同等时间」的口径。
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // 长度不同也要耗同等时间，避免计时侧信道
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

// 通过返回 null；不通过抛 401
export function checkClientAuth(req) {
  const { clientToken } = getConfig().gateway;
  if (!clientToken) return null;
  const h = req.headers;
  const bearer = /^Bearer\s+(.+)$/i.exec(h.authorization || '');
  const presented = (bearer?.[1] ?? h['x-api-key'] ?? '').trim();
  if (presented && safeEqual(presented, clientToken)) return null;
  throw httpError(401, '缺少或错误的网关 API token：请求需携带 Authorization: Bearer <clientToken>（见 providers.json）', 'gateway_auth_failed');
}

// 上游请求统一入口：按 provider 解析凭证头、发起 fetch、上游 401 时按
// provider 策略重试一次（cannwork 重取 VK；静态 token 不重试）。
import { createCannworkAuth } from './auth/cannwork.mjs';
import { createStaticAuth } from './auth/static.mjs';
import { log } from './log.mjs';

// 鉴权解析器按 provider id 缓存。providers.json 热重载后 config 归一化会生成
// 全新的 provider 对象，按对象身份比较即可感知配置变化并重建。
const resolverCache = new Map(); // id -> { providerObj, resolver }

function resolverFor(provider) {
  const hit = resolverCache.get(provider.id);
  if (hit && hit.providerObj === provider) return hit.resolver;
  const r = provider.auth.type === 'cannwork-jwt-vk' ? createCannworkAuth(provider) : createStaticAuth(provider);
  resolverCache.set(provider.id, { providerObj: provider, resolver: r });
  return r;
}

// 供 healthz / 管理台读取各 provider 的凭证状态
export function authStatus(provider) {
  return resolverFor(provider).status();
}

// 上游 fetch 发出的时刻（performance.now）。TTFT 从这里起算，不含本地换凭证的时间。
const fetchStart = new WeakMap();
export const getFetchStart = (res) => fetchStart.get(res) ?? null;

// path 以 /v1/... 开头（provider.baseUrl 统一不含 /v1 后缀，由这里拼接）。
// opts.headers 是业务头（content-type 等），凭证头由 resolver 注入并允许覆盖同名键。
export async function requestUpstream(provider, path, { method = 'POST', headers = {}, body, timeoutMs } = {}) {
  const resolver = resolverFor(provider);
  const h = { ...headers, ...(await resolver.headers()) };
  const url = `${provider.baseUrl}${path}`;
  const send = async () => {
    const ac = new AbortController();
    // 只约束「发请求 → 收到响应头」这段；收到头后立即清掉，
    // 避免把长时间正常生成的流式响应掐死。
    const timer = setTimeout(() => ac.abort(), timeoutMs ?? 180_000);
    const tFetch = performance.now();
    try {
      const res = await fetch(url, { method, headers: h, body, signal: ac.signal });
      fetchStart.set(res, tFetch);
      return res;
    } finally {
      clearTimeout(timer);
    }
  };
  let up = await send();
  // 仅 401 视为凭证失效按 provider 策略重试一次；403（如 "Model not allowed"）是
  // 账号级权限问题，重取凭证无济于事，直接透传给客户端。
  if (up.status === 401) {
    const fresh = await resolver.refresh().catch((e) => {
      log(`provider「${provider.id}」401 后重取凭证失败: ${e.message}`);
      return null;
    });
    if (fresh) {
      log(`401 → 重取凭证重试 ${method} ${provider.id}${path}`);
      Object.assign(h, fresh);
      up = await send();
    }
  }
  return up;
}

// 静态 token 凭证（Kimi For Coding / GLM 等 API key 型订阅）。
//
// token 三种来源（优先级从高到低）:
//   auth.token        内联在 providers.json 里
//   auth.tokenEnv     环境变量名
//   auth.tokenFile    凭证文件路径（可配 auth.tokenJsonPath 用 a.b.c 取字段；否则整文件 trim）
// 每次请求现读（外部工具刷新 token 后立即生效），失败时给出可操作的错误信息。
import fs from 'node:fs';
import { httpError } from '../util.mjs';

function resolveToken(provider) {
  const a = provider.auth;
  if (a.token) return a.token;
  if (a.tokenEnv) {
    const v = process.env[a.tokenEnv];
    if (v) return v.trim();
    throw httpError(502,
      `provider「${provider.id}」未配置凭证：环境变量 ${a.tokenEnv} 为空，请在 launchd/plist 或运行环境中设置`,
      'provider_auth_missing');
  }
  if (a.tokenFile) {
    let raw;
    try { raw = fs.readFileSync(a.tokenFile, 'utf8'); }
    catch (e) { throw httpError(502, `provider「${provider.id}」凭证文件不可读: ${a.tokenFile}（${e.message}）`, 'provider_auth_missing'); }
    if (a.tokenJsonPath) {
      let cur;
      try { cur = JSON.parse(raw); }
      catch (e) { throw httpError(502, `provider「${provider.id}」凭证文件不是合法 JSON: ${a.tokenFile}（${e.message}）`, 'provider_auth_missing'); }
      for (const key of a.tokenJsonPath.split('.').filter(Boolean)) {
        cur = cur?.[key];
        if (cur == null) break;
      }
      if (typeof cur === 'string' && cur) return cur.trim();
      throw httpError(502, `provider「${provider.id}」凭证文件 ${a.tokenFile} 中 ${a.tokenJsonPath} 未取到 token`, 'provider_auth_missing');
    }
    if (raw.trim()) return raw.trim();
    throw httpError(502, `provider「${provider.id}」凭证文件为空: ${a.tokenFile}`, 'provider_auth_missing');
  }
  throw httpError(502,
    `provider「${provider.id}」未配置凭证：请在 providers.json 的 auth 里填 token / tokenEnv / tokenFile`,
    'provider_auth_missing');
}

export function createStaticAuth(provider) {
  return {
    async headers() {
      const token = resolveToken(provider);
      const h = {};
      // Anthropic 兼容上游两种头都收（x-api-key 是官方 SDK 形态，Bearer 是 Claude Code 的
      // ANTHROPIC_AUTH_TOKEN 形态），两个都带以兼容 Kimi / Z.ai 等不同实现
      if (provider.protocol === 'anthropic') {
        h['x-api-key'] = token;
        h.authorization = `Bearer ${token}`;
        h['anthropic-version'] = '2023-06-01';
      } else {
        h.authorization = `Bearer ${token}`;
      }
      return h;
    },
    // 静态 token 没有轮换逻辑：401 直接透传给客户端（凭证配错了就改配置）
    async refresh() { return null; },
    status() {
      try {
        const t = resolveToken(provider);
        return { ok: Boolean(t), tokenSource: a_source(provider), error: null };
      } catch (e) {
        return { ok: false, tokenSource: a_source(provider), error: e.message };
      }
    },
  };
}

function a_source(provider) {
  if (provider.auth.token) return 'inline';
  if (provider.auth.tokenEnv) return `env:${provider.auth.tokenEnv}`;
  if (provider.auth.tokenFile) return `file:${provider.auth.tokenFile}`;
  return 'unset';
}

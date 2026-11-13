// GitHub Copilot OAuth 凭证。
//
// Copilot 不接受长期 GitHub access token 直接调用模型 API，而是先换短期 token，
// 并在请求上附编辑器身份头。Pi 的长期 token 与短期 token 保存在
// ~/.pi/agent/auth.json；网关读取同一份登录，临期/401 时自动刷新并原子写回。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpError } from '../util.mjs';
import { envOf } from '../env.mjs';

const SCRIPT_DIR = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const DEFAULT_AUTH_FILE = path.join(SCRIPT_DIR, 'copilot-auth.json');
const DEFAULT_KEY = 'github-copilot';
const COPILOT_HEADERS = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
};
const COPILOT_API_VERSION = '2026-06-01';
const MODEL_TTL_MS = 10 * 60 * 1000;

let catalogCache = null;
let refreshInflight = null;

function authFileOf(provider) {
  return provider.auth.tokenFile || envOf('PGW_COPILOT_AUTH') || DEFAULT_AUTH_FILE;
}

function authKeyOf(provider) {
  return provider.auth.tokenJsonPath || DEFAULT_KEY;
}

function readRoot(provider) {
  const file = authFileOf(provider);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw httpError(502, `Copilot 凭证文件不可读: ${file}（${e.message}）`, 'provider_auth_missing');
  }
  const key = authKeyOf(provider);
  const cred = key.split('.').filter(Boolean).reduce((cur, part) => cur?.[part], raw);
  if (!cred || typeof cred !== 'object') {
    throw httpError(502, `Copilot 凭证文件 ${file} 中没有 ${key}`, 'provider_auth_missing');
  }
  if (!cred.refresh && !cred.access) {
    throw httpError(502, `Copilot 凭证 ${key} 缺少 refresh/access，请在 Pi 中重新登录 GitHub Copilot`, 'provider_auth_missing');
  }
  return { file, root: raw, key, cred };
}

function writeCredential({ file, root, key, cred }) {
  const next = structuredClone(root);
  const parts = key.split('.').filter(Boolean);
  let cur = next;
  for (const part of parts.slice(0, -1)) {
    cur[part] = cur[part] && typeof cur[part] === 'object' ? cur[part] : {};
    cur = cur[part];
  }
  cur[parts.at(-1)] = cred;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, file);
}

function tokenEndpoint(cred) {
  let domain = 'github.com';
  if (cred.enterpriseUrl) {
    try {
      const raw = String(cred.enterpriseUrl);
      domain = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname;
    } catch {
      throw httpError(502, `Copilot enterpriseUrl 不合法: ${cred.enterpriseUrl}`, 'provider_auth_invalid');
    }
  }
  return `https://api.${domain}/copilot_internal/v2/token`;
}

async function refreshCredential(provider) {
  if (refreshInflight) return refreshInflight;
  refreshInflight = (async () => {
    const stored = readRoot(provider);
    const refresh = stored.cred.refresh;
    if (!refresh) throw httpError(502, 'Copilot 凭证没有 GitHub refresh token，请在 Pi 中重新登录', 'provider_auth_missing');
    const res = await fetch(tokenEndpoint(stored.cred), {
      headers: { Accept: 'application/json', Authorization: `Bearer ${refresh}`, ...COPILOT_HEADERS },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.token || typeof body.expires_at !== 'number') {
      throw httpError(502, `Copilot token 刷新失败: HTTP ${res.status} ${body?.message || body?.error || ''}`.trim(), 'provider_auth_refresh_failed');
    }
    const cred = {
      ...stored.cred,
      type: 'oauth',
      refresh,
      access: body.token,
      expires: body.expires_at * 1000 - 5 * 60 * 1000,
    };
    writeCredential({ ...stored, cred });
    catalogCache = null;
    return cred;
  })().finally(() => { refreshInflight = null; });
  return refreshInflight;
}

async function currentCredential(provider, force = false) {
  const stored = readRoot(provider);
  if (!force && stored.cred.access && (!stored.cred.expires || Date.now() < Number(stored.cred.expires) - 30_000)) {
    return stored.cred;
  }
  return refreshCredential(provider);
}

function payloadOf(body) {
  if (Buffer.isBuffer(body)) {
    try { return JSON.parse(body.toString('utf8')); } catch { return null; }
  }
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { return null; }
  }
  return body && typeof body === 'object' ? body : null;
}

function inferredInitiator(body, urlPath) {
  const payload = payloadOf(body);
  let last = null;
  if (Array.isArray(payload?.messages)) last = payload.messages.at(-1);
  else if (Array.isArray(payload?.input)) last = payload.input.at(-1);
  else if (typeof payload?.input === 'string') last = { role: 'user' };
  if (last?.role) return last.role === 'user' ? 'user' : 'agent';
  return /\/responses?$/.test(urlPath || '') && payload?.previous_response_id ? 'agent' : 'user';
}

function hasImages(body) {
  const payload = payloadOf(body);
  return Boolean(payload && /"type"\s*:\s*"(?:input_image|image_url|image)"/.test(JSON.stringify(payload)));
}

export function createCopilotAuth(provider) {
  return {
    async headers({ body, path: urlPath, method } = {}) {
      const cred = await currentCredential(provider);
      const h = {
        authorization: `Bearer ${cred.access}`,
        ...COPILOT_HEADERS,
        'X-Initiator': inferredInitiator(body, urlPath),
        'Openai-Intent': 'conversation-edits',
        'X-GitHub-Api-Version': COPILOT_API_VERSION,
      };
      if (method === 'GET') h.Accept = 'application/json';
      if (hasImages(body)) h['Copilot-Vision-Request'] = 'true';
      return h;
    },
    async refresh() {
      await refreshCredential(provider);
      return this.headers();
    },
    status() {
      try {
        const { cred, file } = readRoot(provider);
        const exp = Number(cred.expires || 0);
        return {
          ok: Boolean(cred.access || cred.refresh) && (!exp || exp > Date.now()),
          type: 'oauth',
          tokenSource: file,
          expiresAt: exp ? new Date(exp).toISOString() : null,
          expired: Boolean(exp && exp <= Date.now()),
          error: null,
        };
      } catch (e) {
        return { ok: false, type: 'oauth', tokenSource: authFileOf(provider), error: e.message };
      }
    },
  };
}

function endpointAccepted(model, protocol) {
  const endpoints = Array.isArray(model?.supported_endpoints) ? model.supported_endpoints : [];
  if (protocol === 'openai') return endpoints.includes('/chat/completions');
  if (protocol === 'openai-responses') return endpoints.includes('/responses') || endpoints.includes('ws:/responses');
  if (protocol === 'anthropic') return endpoints.includes('/v1/messages') || endpoints.includes('/messages');
  return false;
}

export async function fetchCopilotCatalog(provider) {
  const cred = await currentCredential(provider);
  const key = `${provider.baseUrl}|${cred.access}`;
  if (catalogCache?.key === key && Date.now() - catalogCache.at < MODEL_TTL_MS) {
    return catalogCache.models[provider.protocol] ?? [];
  }
  const res = await fetch(`${provider.baseUrl}/models`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${cred.access}`,
      ...COPILOT_HEADERS,
      'X-GitHub-Api-Version': COPILOT_API_VERSION,
    },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw httpError(502, `Copilot 模型目录拉取失败: HTTP ${res.status}`, 'models_fetch_failed');
  const data = Array.isArray(body?.data) ? body.data : [];
  const models = data.filter((m) => m && typeof m.id === 'string'
    && m.model_picker_enabled === true
    && m.policy?.state !== 'disabled'
    && m.capabilities?.supports?.tool_calls !== false
    && m.capabilities?.type === 'chat');
  const normalize = (m) => ({
    id: m.id,
    title: m.name || m.id,
    contextLength: m.capabilities?.limits?.max_context_window_tokens ?? null,
    maxOutputTokens: m.capabilities?.limits?.max_output_tokens ?? null,
    input: m.capabilities?.supports?.vision ? ['text', 'image'] : ['text'],
  });
  const byProtocol = {
    openai: models.filter((m) => endpointAccepted(m, 'openai')).map(normalize),
    'openai-responses': models.filter((m) => endpointAccepted(m, 'openai-responses')).map(normalize),
    anthropic: models.filter((m) => endpointAccepted(m, 'anthropic')).map(normalize),
  };
  catalogCache = { key, at: Date.now(), models: byProtocol };
  return byProtocol[provider.protocol] ?? [];
}

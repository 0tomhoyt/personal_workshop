#!/usr/bin/env node
// 把 Pi 的日常模型入口收敛到统一网关。
//
// 用法:
//   node scripts/configure-pi.mjs
//   node scripts/configure-pi.mjs --gateway http://127.0.0.1:8488/v1 --dry-run
//
// 保留 ~/.pi/agent/auth.json，不影响 Pi 已有的官方直连账号（作为统一网关故障时的
// 应急通道）；只重写 models.json 的 personal-gateway Provider 和 settings.json 的
// enabledModels，使 /model 默认 scope 仅显示统一网关模型。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const dryRun = process.argv.includes('--dry-run');
const piHome = path.resolve(arg('--pi-home', path.join(os.homedir(), '.pi', 'agent')));
const gateway = arg('--gateway', 'http://127.0.0.1:8484/v1').replace(/\/+$/, '');
let token = arg('--token', process.env.PGW_CLIENT_TOKEN || '');
if (!token) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, 'providers.json'), 'utf8'));
    token = cfg.gateway?.clientToken || '';
  } catch {}
}
if (!token) throw new Error('缺少网关 token：请传 --token 或配置 providers.json gateway.clientToken');

const modelsPath = path.join(piHome, 'models.json');
const settingsPath = path.join(piHome, 'settings.json');
const res = await fetch(`${gateway}/models`, {
  headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  signal: AbortSignal.timeout(15_000),
});
if (!res.ok) throw new Error(`读取网关模型失败: HTTP ${res.status}: ${await res.text()}`);
const catalog = await res.json();
if (!Array.isArray(catalog.data) || catalog.data.length === 0) throw new Error('网关没有返回任何模型');

let oldModels = { providers: {} };
try { oldModels = JSON.parse(fs.readFileSync(modelsPath, 'utf8')); } catch {}
const oldProvider = oldModels.providers?.['personal-gateway'] || {};
const oldById = new Map((oldProvider.models || []).map((m) => [m.id, m]));

const models = catalog.data.map((m) => {
  const owner = String(m.owned_by || 'gateway');
  const upstream = String(m.id || '');
  const prefix = `${owner}/`;
  const slug = upstream.startsWith(prefix) ? upstream : prefix + upstream;
  const api = owner === 'copilot-responses'
    ? 'openai-responses'
    : owner === 'copilot-anthropic'
      ? 'anthropic-messages'
      : undefined;
  const base = structuredClone(oldById.get(slug) || {});
  return {
    ...base,
    id: slug,
    name: m.title || upstream,
    ...(api ? { api } : {}),
    reasoning: base.reasoning ?? true,
    input: Array.isArray(m.input) ? m.input : (base.input || ['text']),
    contextWindow: Number(m.context_length || base.contextWindow || 128000),
    maxTokens: Number(m.max_output_tokens || base.maxTokens || 131072),
  };
});

const nextModels = {
  ...oldModels,
  providers: {
    ...(oldModels.providers || {}),
    'personal-gateway': {
      baseUrl: gateway,
      api: 'openai-completions',
      apiKey: token,
      compat: {
        supportsDeveloperRole: false,
        supportsUsageInStreaming: true,
        maxTokensField: 'max_tokens',
      },
      models,
    },
  },
};

let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
const defaultSlug = arg('--default-model')
  || (models.some((m) => m.id === 'deepseek-official/deepseek-flash') ? 'deepseek-official/deepseek-flash' : models[0].id);
settings.defaultProvider = 'personal-gateway';
settings.defaultModel = defaultSlug;
settings.enabledModels = models.map((m) => `personal-gateway/${m.id}`);

console.log(`Pi 配置目录: ${piHome}`);
console.log(`网关: ${gateway}`);
console.log(`统一网关模型: ${models.length}`);
for (const m of models) console.log(`  ${m.id} -> ${m.api || 'openai-completions'}`);

if (!dryRun) {
  fs.mkdirSync(piHome, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  for (const file of [modelsPath, settingsPath]) {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-${stamp}`);
  }
  fs.writeFileSync(modelsPath, JSON.stringify(nextModels, null, 2) + '\n', 'utf8');
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCopilotAuth, fetchCopilotCatalog } from '../lib/auth/copilot.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgw-copilot-'));
const authFile = path.join(dir, 'auth.json');
const future = Date.now() + 60 * 60 * 1000;
fs.writeFileSync(authFile, JSON.stringify({
  'github-copilot': {
    type: 'oauth',
    refresh: 'github-refresh',
    access: 'copilot-access',
    expires: future,
  },
}), 'utf8');

const provider = {
  id: 'copilot-chat',
  baseUrl: 'https://api.individual.githubcopilot.com',
  protocol: 'openai',
  auth: { type: 'copilot-oauth', tokenFile: authFile, tokenJsonPath: 'github-copilot' },
};

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const originalFetch = globalThis.fetch;
try {
  await check('有效 token 注入 Copilot 身份头', async () => {
    const auth = createCopilotAuth(provider);
    const h = await auth.headers({
      path: '/v1/chat/completions',
      body: Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })),
    });
    assert.equal(h.authorization, 'Bearer copilot-access');
    assert.equal(h['Copilot-Integration-Id'], 'vscode-chat');
    assert.equal(h['X-Initiator'], 'user');
  });

  await check('工具续轮标记为 agent', async () => {
    const h = await createCopilotAuth(provider).headers({
      path: '/v1/chat/completions',
      body: Buffer.from(JSON.stringify({ messages: [{ role: 'tool', content: 'result' }] })),
    });
    assert.equal(h['X-Initiator'], 'agent');
  });

  await check('图片请求带 Copilot-Vision-Request', async () => {
    const h = await createCopilotAuth(provider).headers({
      path: '/v1/responses',
      body: Buffer.from(JSON.stringify({ input: [{ role: 'user', content: [{ type: 'input_image' }] }] })),
    });
    assert.equal(h['Copilot-Vision-Request'], 'true');
  });

  globalThis.fetch = async (url) => {
    assert.equal(String(url), 'https://api.individual.githubcopilot.com/models');
    return new Response(JSON.stringify({ data: [
      { id: 'chat-a', name: 'Chat A', model_picker_enabled: true, supported_endpoints: ['/chat/completions'], capabilities: { type: 'chat', supports: { tool_calls: true, vision: true }, limits: { max_context_window_tokens: 1000, max_output_tokens: 100 } } },
      { id: 'resp-a', name: 'Resp A', model_picker_enabled: true, supported_endpoints: ['/responses'], capabilities: { type: 'chat', supports: { tool_calls: true, vision: false }, limits: { max_context_window_tokens: 2000, max_output_tokens: 200 } } },
      { id: 'disabled-a', name: 'Disabled', model_picker_enabled: true, policy: { state: 'disabled' }, supported_endpoints: ['/chat/completions'], capabilities: { type: 'chat', supports: { tool_calls: true }, limits: {} } },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  await check('目录只返回当前协议可用模型', async () => {
    const models = await fetchCopilotCatalog(provider);
    assert.deepEqual(models.map((m) => m.id), ['chat-a']);
    assert.equal(models[0].maxOutputTokens, 100);
  });

  await check('目录按 Responses 端点分流', async () => {
    const models = await fetchCopilotCatalog({ ...provider, id: 'copilot-responses', protocol: 'openai-responses' });
    assert.deepEqual(models.map((m) => m.id), ['resp-a']);
  });

  await check('短期 token 过期时自动刷新并回写凭证', async () => {
    const refreshedProvider = {
      ...provider,
      id: 'copilot-refresh',
      auth: { type: 'copilot-oauth', tokenFile: authFile, tokenJsonPath: 'github-copilot' },
    };
    const expired = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    expired['github-copilot'].access = 'expired-access';
    expired['github-copilot'].expires = Date.now() - 1000;
    fs.writeFileSync(authFile, JSON.stringify(expired), 'utf8');
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://api.github.com/copilot_internal/v2/token');
      assert.equal(init.headers.Authorization, 'Bearer github-refresh');
      return new Response(JSON.stringify({ token: 'fresh-access', expires_at: Math.floor(Date.now() / 1000) + 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const h = await createCopilotAuth(refreshedProvider).headers({ path: '/v1/chat/completions', body: '{}' });
    assert.equal(h.authorization, 'Bearer fresh-access');
    const stored = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    assert.equal(stored['github-copilot'].access, 'fresh-access');
  });
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`copilot: ${passed} passed, 0 failed`);

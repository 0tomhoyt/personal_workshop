#!/usr/bin/env node
// 统一订阅 API 网关（前 cannbot-gateway-proxy）—— 集中管理多个订阅上游，
// 供本机所有 Agent（Zcode / Claude Code / opencode / 任意 OpenAI 或 Anthropic 客户端）统一调用。
//
//   OpenAI 客户端    → http://127.0.0.1:<PORT>/v1/chat/completions
//   Anthropic 客户端 → http://127.0.0.1:<PORT>/v1/messages
//        ↓ 按请求体里的 model 路由到对应订阅（providers.json），
//          同协议原样直通（仅注入凭证），跨协议走双向翻译
//
// 上游与凭证全部在 providers.json 里声明（运行时目录，0600）：
//   cannbot  CANNWork 订阅（JWT+VK 凭证链，见 lib/auth/cannwork.mjs）
//   kimi / zcode 等静态 token 订阅（见 lib/auth/static.mjs）
// 客户端凭 gateway.clientToken 鉴权（未配置时不校验）。
//
// 运行时文件（proxy.log / vk-cache.json / stats.json）落在本脚本所在目录，随项目文件夹整体移动。
// 端口: 8484（环境变量 CANNBOT_PROXY_PORT 优先，其次 providers.json gateway.port），只绑 127.0.0.1
// 推荐由 launchd 托管（见 install.sh），也可前台直接 `node server.mjs` 运行。

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { log, tailLog } from './lib/log.mjs';
import { getConfig, tryGetConfig, getProvider } from './lib/config.mjs';
import { statsSnapshot, flushStats } from './lib/stats.mjs';
import { listModels, resolveModelRoute, defaultProvider, peekModelsKnown, checkProviderCatalog } from './lib/models.mjs';
import { providersView, createProvider, updateProvider, deleteProvider } from './lib/providers-admin.mjs';
import { forward, readRequestBody, withUpstreamModel } from './lib/proxy-openai.mjs';
import { handleAnthropicInbound, handleOpenAIToAnthropic } from './lib/proxy-anthropic.mjs';
import { checkClientAuth } from './lib/gwauth.mjs';
import { authStatus } from './lib/upstream.mjs';
import { monitorsStatus, switchMonitors } from './lib/monitors.mjs';
import { renameMonitors } from './lib/monitors-admin.mjs';
import { listTodos, createTodo, updateTodo, deleteTodo } from './lib/todos.mjs';
import { httpError, sendJson, extractModel } from './lib/util.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const startupConfig = tryGetConfig();
// 请求体上限：Anthropic 官方 Messages API 即 32MB（更大也送不出去），且翻译路径
// parse/stringify 会瞬时多份拷贝，上限越大单请求内存尖峰越高。
// env CANNBOT_MAX_BODY_MB > providers.json gateway.maxBodyMB > 32MB。
const MAX_BODY = Math.max(1, Number(process.env.CANNBOT_MAX_BODY_MB)
  || Number(startupConfig.gateway?.maxBodyMB)
  || 32) * 1024 * 1024;

const PORT = Number(process.env.CANNBOT_PROXY_PORT)
  || Number(startupConfig.gateway?.port)
  || 8484;

// DNS-rebinding 防护：状态变更端点要求 Host 为本机回环地址
function isLocalHost(req) {
  const host = (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '';
}

const ADMIN_HTML = path.join(SCRIPT_DIR, 'admin.html');
const LAUNCH_LABEL = 'cn.hicann.cannbot-gateway-proxy';
const LAUNCH_TARGET = `gui/${os.userInfo().uid}/${LAUNCH_LABEL}`;

function launchctl(args) {
  execFile('/bin/launchctl', args, { timeout: 10_000 }, (e) => {
    if (e) log(`launchctl ${args.join(' ')} 失败: ${e.message}`);
  });
}

// 请求模型 → { provider, model } 路由。查不到目录时回落默认上游原样透传（自愈新模型名）。
async function routeFor(model) {
  const r = await resolveModelRoute(model);
  if (r) return r;
  const p = defaultProvider();
  if (!p) throw httpError(502, '没有已启用的上游 provider，请检查 providers.json', 'no_provider');
  return { provider: p, model: model ?? null, explicit: false };
}

const server = http.createServer(async (req, res) => {
  try {
    // 容忍客户端把 Base URL 写成带 /v1 再叠 SDK 自动拼接的情况（/v1/v1/messages → /v1/messages）
    const url = req.url.split('?')[0].replace(/^(\/v1)+(?=\/)/, '/v1');

    if (url === '/healthz') {
      const config = tryGetConfig();
      const providers = config.providers?.filter((p) => p.enabled) ?? [];
      const details = providers.map((p) => {
        const known = peekModelsKnown().find((x) => x.id === p.id);
        return {
          id: p.id,
          name: p.name,
          protocol: p.protocol,
          baseUrl: p.baseUrl,
          auth: authStatus(p),
          modelsKnown: known?.count ?? null,
          catalogError: known?.error ?? null,
        };
      });
      return sendJson(res, 200, {
        ok: details.every((d) => d.auth?.ok ?? d.auth?.jwt?.ok) && details.length > 0,
        service: 'unified-subscription-gateway',
        authRequired: Boolean(config.gateway?.clientToken),
        protocols: ['openai (passthrough / translated)', 'anthropic messages (direct / translated)'],
        providers: details,
        uptimeSec: Math.round(process.uptime()),
      });
    }

    if (url === '/' || url === '/admin') {
      try {
        const html = fs.readFileSync(ADMIN_HTML);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      } catch {
        return sendJson(res, 404, { error: { message: 'admin.html 缺失：重跑 ./install.sh 安装', type: 'not_found' } });
      }
    }

    if (url === '/admin/log') {
      return sendJson(res, 200, { lines: tailLog(80) });
    }

    // 管理台取网关 token（仅回环 Host）：测试/对比按钮要带 token 调 /v1/*
    if (url === '/admin/config') {
      if (!isLocalHost(req)) {
        return sendJson(res, 403, { error: { message: '仅允许通过 127.0.0.1/localhost 访问此端点', type: 'forbidden' } });
      }
      const config = tryGetConfig();
      return sendJson(res, 200, {
        clientToken: config.gateway?.clientToken ?? null,
        port: PORT,
        providers: (config.providers ?? []).filter((p) => p.enabled).map((p) => ({ id: p.id, name: p.name, protocol: p.protocol })),
      });
    }

    // 状态变更端点（重启/停止）只接受 POST：避免 <img>/链接/预取等 GET 误触发
    if (url === '/admin/restart' || url === '/admin/stop') {
      if (req.method !== 'POST') {
        return sendJson(res, 405, { error: { message: '此端点仅接受 POST', type: 'method_not_allowed' } });
      }
      if (!isLocalHost(req)) {
        return sendJson(res, 403, { error: { message: '仅允许通过 127.0.0.1/localhost 访问此端点', type: 'forbidden' } });
      }
      const stopping = url === '/admin/stop';
      sendJson(res, 200, {
        ok: true,
        message: stopping ? '服务停止中' : '服务重启中，几秒后自动恢复',
      });
      const args = stopping
        ? ['bootout', LAUNCH_TARGET]
        : ['kickstart', '-k', LAUNCH_TARGET];
      return setTimeout(() => launchctl(args), 300).unref();
    }

    if (url === '/admin/stats') {
      return sendJson(res, 200, statsSnapshot());
    }

    // 显示器输入源切换（m1ddc/DDC）：状态查询（带缓存，?refresh=1 绕过）只读但属
    // 本机环境信息，同样仅回环 Host；切换是状态变更 → POST + 回环 + JSON 内容类型
    // （与 providers 写操作同一威胁模型，防 CSRF / DNS rebinding）。
    if (url === '/admin/monitors') {
      if (!isLocalHost(req)) {
        return sendJson(res, 403, { error: { message: '仅允许通过 127.0.0.1/localhost 访问此端点', type: 'forbidden' } });
      }
      if (req.method !== 'GET') {
        return sendJson(res, 405, { error: { message: '此端点仅接受 GET', type: 'method_not_allowed' } });
      }
      const refresh = /[?&]refresh=1\b/.test(req.url);
      return sendJson(res, 200, await monitorsStatus({ refresh }));
    }
    if (url === '/admin/monitors/switch') {
      if (req.method !== 'POST') {
        return sendJson(res, 405, { error: { message: '此端点仅接受 POST', type: 'method_not_allowed' } });
      }
      if (!isLocalHost(req)) {
        return sendJson(res, 403, { error: { message: '仅允许通过 127.0.0.1/localhost 访问此端点', type: 'forbidden' } });
      }
      if (!(req.headers['content-type'] || '').includes('application/json')) {
        return sendJson(res, 415, { error: { message: '请求体需为 application/json', type: 'unsupported_media_type' } });
      }
      const bodyBuf = await readRequestBody(req, 4096);
      let payload = null;
      try { payload = JSON.parse(bodyBuf.toString('utf8') || '{}'); } catch {}
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return sendJson(res, 400, { error: { message: '请求体不是合法 JSON 对象', type: 'bad_request' } });
      }
      return sendJson(res, 200, await switchMonitors(payload));
    }
    // 改名：写 providers.json 的 monitors 节（与 providers 写操作同一威胁模型）
    if (url === '/admin/monitors/rename') {
      if (req.method !== 'POST') {
        return sendJson(res, 405, { error: { message: '此端点仅接受 POST', type: 'method_not_allowed' } });
      }
      if (!isLocalHost(req)) {
        return sendJson(res, 403, { error: { message: '仅允许通过 127.0.0.1/localhost 访问此端点', type: 'forbidden' } });
      }
      if (!(req.headers['content-type'] || '').includes('application/json')) {
        return sendJson(res, 415, { error: { message: '请求体需为 application/json', type: 'unsupported_media_type' } });
      }
      const bodyBuf = await readRequestBody(req, 4096);
      let payload = null;
      try { payload = JSON.parse(bodyBuf.toString('utf8') || '{}'); } catch {}
      return sendJson(res, 200, renameMonitors(payload));
    }

    // 供应商配置管理（管理台）：视图含脱敏凭证信息，仅回环 Host 可读；增删改/测试
    // 额外要求 application/json —— 跨站表单发不出该内容类型的简单请求，配合回环
    // Host 校验即同时防 CSRF 与 DNS rebinding（与 restart/stop 同一威胁模型）。
    if (url === '/admin/providers' || url.startsWith('/admin/providers/')) {
      if (!isLocalHost(req)) {
        return sendJson(res, 403, { error: { message: '仅允许通过 127.0.0.1/localhost 访问此端点', type: 'forbidden' } });
      }
      const sub = url.slice('/admin/providers'.length).replace(/^\//, '');
      if (req.method === 'GET') {
        if (sub) return sendJson(res, 405, { error: { message: '此端点不支持 GET（视图请用 /admin/providers）', type: 'method_not_allowed' } });
        return sendJson(res, 200, providersView());
      }
      if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'DELETE') {
        return sendJson(res, 405, { error: { message: '此端点仅支持 GET/POST/PUT/DELETE', type: 'method_not_allowed' } });
      }
      // POST/PUT 带请求体，强制 JSON 内容类型（跨站表单发不出 application/json 的
      // 简单请求）；DELETE 无请求体，方法本身 HTML 表单就伪造不了，不必要求。
      if (req.method !== 'DELETE' && !(req.headers['content-type'] || '').includes('application/json')) {
        return sendJson(res, 415, { error: { message: '请求体需为 application/json', type: 'unsupported_media_type' } });
      }
      // DELETE 无请求体也走同一解析（空体 → {}）；配置 JSON 远小于代理请求体，给小上限
      const bodyBuf = await readRequestBody(req, 1024 * 1024);
      let payload = null;
      try { payload = JSON.parse(bodyBuf.toString('utf8') || '{}'); } catch {}
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return sendJson(res, 400, { error: { message: '请求体不是合法 JSON 对象', type: 'bad_request' } });
      }
      let id = null;
      let action = null;
      if (sub) {
        const parts = sub.split('/');
        try { id = decodeURIComponent(parts[0]); } catch { id = parts[0]; }
        action = parts[1] ?? null;
      }
      if (req.method === 'POST' && id && action === 'check') {
        const p = getProvider(id);
        if (!p) return sendJson(res, 404, { error: { message: `provider「${id}」不存在`, type: 'not_found' } });
        return sendJson(res, 200, await checkProviderCatalog(p));
      }
      if (req.method === 'POST' && !sub) {
        return sendJson(res, 201, { ok: true, ...createProvider(payload, { port: PORT }) });
      }
      if (req.method === 'PUT' && id && !action) {
        return sendJson(res, 200, { ok: true, ...updateProvider(id, payload, { port: PORT }) });
      }
      if (req.method === 'DELETE' && id && !action) {
        return sendJson(res, 200, { ok: true, ...deleteProvider(id, { port: PORT }) });
      }
      return sendJson(res, 404, { error: { message: `未知的管理端点 ${url}`, type: 'not_found' } });
    }

    // 待办事项（个人工作台）：人（工作台网页）与各 agent（Bearer token）共用的任务中枢。
    // 与 /v1/chat/completions 同一威胁模型：Bearer 鉴权即可——跨站表单带不了
    // Authorization 头，不必另强制 JSON 内容类型。必须放在 /v1/* catch-all 之前。
    if (url === '/v1/todos' || url.startsWith('/v1/todos/')) {
      checkClientAuth(req);
      const sub = url.slice('/v1/todos'.length).replace(/^\//, '');
      let id = null;
      if (sub) {
        const first = sub.split('/')[0];
        try { id = decodeURIComponent(first); } catch { id = first; }
      }
      if (req.method === 'GET' && !id) {
        // query string 在入口已被剥掉，过滤参数从 req.url 原文取
        const m = /[?&]status=([^&]*)/.exec(req.url || '');
        const filter = {};
        if (m) {
          try { filter.status = decodeURIComponent(m[1]); } catch { filter.status = m[1]; }
        }
        return sendJson(res, 200, { todos: listTodos(filter) });
      }
      const wantsBody = (req.method === 'POST' && !id) || (req.method === 'PUT' && id);
      if (wantsBody) {
        const bodyBuf = await readRequestBody(req, 64 * 1024);
        let payload = null;
        try { payload = JSON.parse(bodyBuf.toString('utf8') || '{}'); } catch {}
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          return sendJson(res, 400, { error: { message: '请求体不是合法 JSON 对象', type: 'bad_request' } });
        }
        if (req.method === 'POST') return sendJson(res, 201, { ok: true, todo: createTodo(payload) });
        return sendJson(res, 200, { ok: true, todo: updateTodo(id, payload) });
      }
      if (req.method === 'DELETE' && id) {
        deleteTodo(id);
        res.writeHead(204);
        return res.end();
      }
      return sendJson(res, 405, { error: { message: '此端点仅支持 GET/POST/PUT/DELETE', type: 'method_not_allowed' } });
    }

    if (url === '/v1/models') {
      checkClientAuth(req);
      const list = await listModels();
      return sendJson(res, 200, list);
    }

    if (url === '/v1/messages' || url === '/messages') {
      checkClientAuth(req);
      const bodyBuf = await readRequestBody(req, MAX_BODY);
      let body = {};
      try { body = JSON.parse(bodyBuf.toString('utf8') || '{}'); } catch { body = null; }
      if (!body || typeof body !== 'object') {
        return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: '请求体不是合法 JSON 对象' } });
      }
      if (!body.model) {
        return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Anthropic 请求缺少 model 字段' } });
      }
      const route = await routeFor(body.model);
      return await handleAnthropicInbound(req, res, bodyBuf, body, route);
    }

    if (url.startsWith('/v1/')) {
      checkClientAuth(req);
      let bodyBuf = await readRequestBody(req, MAX_BODY);
      const requestedModel = extractModel(bodyBuf);
      const route = await routeFor(requestedModel);
      if (route.provider.protocol === 'anthropic') {
        let body = {};
        try { body = JSON.parse(bodyBuf.toString('utf8') || '{}'); } catch { body = {}; }
        return await handleOpenAIToAnthropic(req, res, url, bodyBuf, body, route);
      }
      // 显式 pid/model 时把 body.model 改回上游真实名；裸名/默认上游保持原字节
      if (route.explicit) {
        bodyBuf = withUpstreamModel(bodyBuf, route.model);
      }
      return await forward(req, res, url, bodyBuf, route);
    }

    return sendJson(res, 404, {
      error: { message: `未知路径 ${url}；可用: / (管理台), /v1/chat/completions, /v1/messages, /v1/models, /healthz`, type: 'not_found' },
    });
  } catch (e) {
    const status = e.status ?? 500;
    log(`ERROR ${req.method} ${req.url} → ${status}: ${e.message}`);
    if (!res.headersSent) {
      sendJson(res, status, { error: { message: e.message, type: e.code ?? 'internal_error' } });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  const config = tryGetConfig();
  const names = (config.providers ?? []).filter((p) => p.enabled).map((p) => p.id).join(', ') || '（无）';
  log(`统一订阅网关就绪: http://${HOST}:${PORT}/v1 → 上游 [${names}]`
    + `（OpenAI /v1/* 透传或翻译；Anthropic /v1/messages 直通或翻译）`
    + (config.gateway?.clientToken ? '；客户端鉴权已启用' : '；未配置客户端鉴权'));
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { log(`收到 ${sig}，退出`); flushStats(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
}

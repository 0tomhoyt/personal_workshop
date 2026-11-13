// Codex Responses API 端到端回归：
//   Responses → openai Chat 翻译（流式/非流式/工具/多轮工具结果）
//   Responses → openai-responses 原样直通
//   Responses → anthropic 明确拒绝
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MOCK_PORT = 6391;
const GW_PORT = 6390;
const GW = `http://127.0.0.1:${GW_PORT}`;
const TOKEN = 'responses-test-token';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'responses-smoke-'));

fs.writeFileSync(path.join(tmp, 'providers.json'), JSON.stringify({
  gateway: { clientToken: TOKEN },
  providers: [
    {
      id: 'mock-oai',
      name: 'Mock OpenAI',
      baseUrl: `http://127.0.0.1:${MOCK_PORT}/oai`,
      protocol: 'openai',
      auth: { type: 'static-token', token: 'mock-token-oai' },
      models: { source: 'api' },
    },
    {
      id: 'mock-native',
      name: 'Mock Responses',
      baseUrl: `http://127.0.0.1:${MOCK_PORT}/resnative`,
      protocol: 'openai-responses',
      auth: { type: 'static-token', token: 'mock-token-responses' },
      models: { source: 'api' },
    },
    {
      id: 'mock-anth',
      name: 'Mock Anthropic',
      baseUrl: `http://127.0.0.1:${MOCK_PORT}/anth`,
      protocol: 'anthropic',
      auth: { type: 'static-token', token: 'mock-token-anthropic' },
      models: { source: 'static', list: [{ id: 'claude-mock' }] },
    },
  ],
  routing: { defaultProvider: 'mock-oai', aliases: {} },
}, null, 2));

const childEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  PGW_PROXY_PORT: String(GW_PORT),
  PGW_CONFIG_FILE: path.join(tmp, 'providers.json'),
  PGW_LOG_FILE: path.join(tmp, 'proxy.log'),
  PGW_STATS_FILE: path.join(tmp, 'stats.json'),
  PGW_SKIP_LAUNCHCTL: '1',
};

function spawnNode(args, env, name) {
  const child = spawn(process.execPath, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk));
  child.stderr.on('data', (chunk) => output.push(chunk));
  child.dump = () => console.error(`---- ${name} ----\n${Buffer.concat(output).toString('utf8').slice(-5000)}`);
  return child;
}

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const mock = spawnNode([path.join(ROOT, 'test/mock-upstream.mjs'), String(MOCK_PORT)], {}, 'mock-upstream');
const gateway = spawnNode([path.join(ROOT, 'server.mjs')], childEnv, 'gateway');
const headers = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function post(body, pathName = '/v1/responses') {
  return fetch(GW + pathName, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function events(response) {
  const text = await response.text();
  return {
    text,
    events: text.split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => {
        try { return JSON.parse(line.slice(5).trim()); } catch { return null; }
      })
      .filter(Boolean),
  };
}

try {
  let up = false;
  for (let i = 0; i < 80; i++) {
    try {
      const health = await (await fetch(`${GW}/healthz`)).json();
      if (health.service) { up = true; break; }
    } catch {}
    await sleep(100);
  }
  if (!up) throw new Error('gateway did not start');

  {
    const { responsesToChat } = await import(pathToFileURL(path.join(ROOT, 'lib/proxy-responses.mjs')).href + `?t=${Date.now()}`);
    const { chat, canonical } = responsesToChat({
      stream: true,
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'dev' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      ],
      tools: [{
        type: 'namespace',
        name: 'multi_agent',
        tools: [{
          type: 'function',
          name: 'spawn',
          parameters: { type: 'object', properties: {} },
        }],
      }],
    }, 'upstream-model');
    check('namespace tool 扁平化', chat.tools?.[0]?.function?.name === 'multi_agent__spawn');
    check('developer 映射为 system', chat.messages?.[0]?.role === 'system' && chat.messages[0].content === 'dev');
    check('namespace 可反向映射', canonical.get('multi_agent__spawn')?.namespace === 'multi_agent');
  }

  {
    const r = await fetch(`${GW}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' } });
    check('Responses 无网关 token → 401', r.status === 401, String(r.status));
  }

  {
    const r = await post({
      model: 'mock-oai/mock-pro',
      stream: false,
      max_output_tokens: 50,
      input: 'translate me',
    });
    const json = await r.json();
    const text = json.output?.find((item) => item.type === 'message')?.content?.[0]?.text || '';
    const echo = JSON.parse(text.replace(/^ECHO:/, ''));
    check('Chat 上游非流式翻译为 Responses', r.status === 200 && json.object === 'response', JSON.stringify(json).slice(0, 200));
    check('上游 model 名已剥 provider 前缀', echo.model === 'mock-pro', text.slice(0, 120));
    check('Responses max_output_tokens 映射为 max_tokens', echo.max_tokens === 50);
    check('Responses usage 映射', json.usage?.input_tokens === 9 && json.usage?.output_tokens === 12);
  }

  {
    const r = await post({
      model: 'mock-oai/mock-pro',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'stream me' }] }],
    });
    const { events: list } = await events(r);
    const outputText = list.filter((event) => event.type === 'response.output_text.delta')
      .map((event) => event.delta).join('');
    check('Chat 上游流式翻译为 Responses SSE', r.status === 200 && list.some((event) => event.type === 'response.completed'));
    check('流式文本通过 output_text.delta 返回', outputText.startsWith('ECHO:'), outputText.slice(0, 120));
    check('完整 Responses 生命周期事件', ['response.created', 'response.output_item.added', 'response.output_item.done']
      .every((type) => list.some((event) => event.type === type)));
  }

  {
    const r = await post({
      model: 'mock-oai/mock-tool',
      stream: false,
      input: 'use a tool',
      tools: [{
        type: 'function',
        name: 'exec_command',
        description: 'Run a command',
        parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
      }],
    });
    const json = await r.json();
    const call = json.output?.find((item) => item.type === 'function_call');
    check('Chat tool_calls 翻译为 Responses function_call', call?.name === 'exec_command' && call?.call_id === 'call_mock_tool');
    check('工具参数逐字保留', call?.arguments === '{"cmd":"Write-Output MOCK_TOOL"}');
  }

  {
    const r = await post({
      model: 'mock-oai/mock-pro',
      stream: false,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continued' }] },
        { type: 'function_call', call_id: 'call_prev', name: 'exec_command', arguments: '{"cmd":"x"}' },
        { type: 'function_call_output', call_id: 'call_prev', output: 'previous output' },
      ],
    });
    const json = await r.json();
    const text = json.output?.find((item) => item.type === 'message')?.content?.[0]?.text || '';
    const echo = JSON.parse(text.replace(/^ECHO:/, ''));
    check('多轮 function_call 回放为 assistant.tool_calls',
      echo.messages?.some((message) => message.role === 'assistant' && message.tool_calls?.[0]?.id === 'call_prev'));
    check('function_call_output 回放为 role:tool',
      echo.messages?.some((message) => message.role === 'tool' && message.tool_call_id === 'call_prev' && message.content === 'previous output'));
  }

  {
    const r = await post({
      model: 'mock-native/native-model',
      stream: false,
      input: 'native',
    });
    const json = await r.json();
    check('原生 Responses 上游非流式直通', r.status === 200
      && json.output?.[0]?.content?.[0]?.text === 'NATIVE:native-model');
  }

  {
    const r = await post({
      model: 'mock-native/native-model',
      stream: true,
      input: 'native stream',
    });
    const { events: list } = await events(r);
    check('原生 Responses 上游 SSE 直通', r.status === 200
      && list.some((event) => event.type === 'response.completed'));
    check('原生 Responses 内容未二次翻译',
      list.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta).join('') === 'NATIVE:native-model');
  }

  {
    const r = await post({ model: 'mock-anth/claude-mock', stream: false, input: 'unsupported' });
    const json = await r.json();
    check('Anthropic 上游明确返回 501，不静默降级',
      r.status === 501 && json.error?.type === 'responses_protocol_unsupported');
  }

  {
    const codexHome = path.join(tmp, 'codex-home');
    const setup = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts/configure-codex.mjs'),
      '--config', path.join(tmp, 'providers.json'),
      '--codex-home', codexHome,
    ], {
      env: { ...process.env, ...childEnv },
      encoding: 'utf8',
    });
    const catalog = JSON.parse(fs.readFileSync(path.join(codexHome, 'unified-models.json'), 'utf8'));
    const slugs = catalog.models.map((model) => model.slug);
    const codexConfig = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    check('Codex 配置生成成功', setup.status === 0, setup.stderr || setup.stdout);
    check('Codex 目录只包含可服务 Responses 的 provider',
      slugs.includes('mock-oai/mock-pro') && slugs.includes('mock-native/native-model') && !slugs.includes('mock-anth/claude-mock'),
      slugs.join(','));
    check('Codex config.toml 指向本地网关', codexConfig.includes('wire_api = "responses"')
      && codexConfig.includes(`http://127.0.0.1:${GW_PORT}/v1`)
      && codexConfig.includes('model_provider = "personal-gateway"'));
  }

  const models = await (await fetch(`${GW}/v1/models`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  check('/v1/models 聚合 Responses provider', models.data?.some((model) => model.owned_by === 'mock-native'));
} catch (error) {
  failures.push(error.message);
  console.error(error.stack || error);
  gateway.dump();
  mock.dump();
} finally {
  gateway.kill('SIGTERM');
  mock.kill('SIGTERM');
  await sleep(100);
}

console.log(`\nresponses: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error(failures.map((failure) => `FAIL: ${failure}`).join('\n'));
  process.exitCode = 1;
}

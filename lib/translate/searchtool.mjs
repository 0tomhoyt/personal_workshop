// 搜索工具跨方言映射：Anthropic web_search server tool ⇄ 智谱 web_search / Kimi $web_search。
// 方言判断只按 baseUrl 推断（config.mjs normalizeProvider 白名单重建对象会丢弃未知配置键，
// 搜索方言没法走配置字段）。上游字段形态来自官方文档抓取（docs.bigmodel.cn /
// platform.kimi.com）；未经核验的传闻形态（智谱流式 delta.content 数组、Anthropic
// server_tool_use 块字段名等）在消费端一律按容错解析实现，字段缺失不抛错。
import { randHex } from '../util.mjs';

// 按 baseUrl 推断上游搜索方言：
//   含 'bigmodel' / 'zhipu' / 'z.ai'（覆盖 bigmodel.cn / zhipuai.cn 与 GLM Coding Plan 的
//     api.z.ai——该域名 anthropic 兼容端点走同协议直通不进翻译，但若配成 openai 协议
//     端点同样按智谱方言映射；测试 mock 的 .../zhipu、.../z.ai 路径前缀同理命中）→ 'zhipu'
//   含 'moonshot' 或 'kimi' → 'kimi'
//   否则 null（上游无搜索工具映射能力）
export function searchDialect(provider) {
  const url = String(provider?.baseUrl || '');
  if (url.includes('bigmodel') || url.includes('zhipu') || url.includes('z.ai')) return 'zhipu';
  if (url.includes('moonshot') || url.includes('kimi')) return 'kimi';
  return null;
}

// Anthropic web_search server tool → 智谱 tools 元素形态。
// max_uses 与 count 语义不等价（搜索次数 vs 单次结果条数），不映射；
// blocked_domains / user_location 智谱无对应字段，丢弃。
export function zhipuSearchTool(t) {
  return {
    type: 'web_search',
    web_search: {
      enable: true,
      search_engine: 'search_pro',
      search_result: true,
      ...(Array.isArray(t?.allowed_domains) && t.allowed_domains.length ? { search_domain_filter: t.allowed_domains } : {}),
    },
  };
}

// Anthropic web_search server tool → Kimi builtin_function 形态（无参数）
export function kimiSearchTool() {
  return { type: 'builtin_function', function: { name: '$web_search' } };
}

// 智谱搜索结果数组 → Anthropic server_tool_use + web_search_tool_result 块对。
// url / title 为已旁证的官方字段；上游摘要逐字放扩展键 content（严格客户端忽略
// 未知键也不丢内容）；encrypted_index / page_age 未经核验，不伪造。
export function zhipuResultBlocks(results) {
  const id = `srvtoolu_${randHex()}`;
  return [
    { type: 'server_tool_use', id, name: 'web_search', input: {} },
    {
      type: 'web_search_tool_result',
      tool_use_id: id,
      content: results.map((r) => ({
        type: 'web_search_result',
        url: r?.link ?? '',
        title: r?.title ?? '',
        content: typeof r?.content === 'string' ? r.content : '',
      })),
    },
  ];
}

// 搜索内容降级为纯文本：query 与结果的 title/url/content 全部逐字嵌入（红线：
// 不 trim / 不改写），只加 [web_search] / - 前缀标记与换行分隔。
export function formatSearchAsText(mainText, queries = [], results = []) {
  const lines = [
    ...queries.map((q) => `[web_search] ${q}`),
    ...results.map((r) => `- ${r?.title ?? ''} ${r?.url ?? ''}${typeof r?.content === 'string' && r.content ? '\n' + r.content : ''}`),
  ];
  return (mainText ? mainText + '\n' : '') + lines.join('\n');
}

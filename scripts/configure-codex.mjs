#!/usr/bin/env node
// Generate a Codex model catalog from the gateway's enabled providers and point
// ~/.codex/config.toml at the local /v1/responses endpoint.
//
// Usage:
//   node scripts/configure-codex.mjs --config /path/to/providers.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const configPath = path.resolve(arg('--config', process.env.PGW_CONFIG_FILE || path.join(process.cwd(), 'providers.json')));
const codexHome = path.resolve(arg('--codex-home', path.join(os.homedir(), '.codex')));
const catalogPath = path.resolve(arg('--catalog', path.join(codexHome, 'unified-models.json')));
const dryRun = process.argv.includes('--dry-run');

process.env.PGW_CONFIG_FILE = configPath;
process.env.PGW_SKIP_LAUNCHCTL = '1';

const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const codexConfig = raw.codex && typeof raw.codex === 'object' ? raw.codex : {};
const { getConfig } = await import('../lib/config.mjs');
const { listModels } = await import('../lib/models.mjs');
const config = getConfig();
const catalog = await listModels();

const excludedProviders = new Set(Array.isArray(codexConfig.excludeProviders)
  ? codexConfig.excludeProviders.map(String)
  : []);
const allowedModels = Array.isArray(codexConfig.models)
  ? new Set(codexConfig.models.map(String))
  : null;

const modelEntries = catalog.data
  .filter((model) => !excludedProviders.has(model.owned_by))
  .map((model) => {
    const provider = config.providers.find((item) => item.id === model.owned_by);
    const prefix = `${model.owned_by}/`;
    const upstream = model.id.startsWith(prefix) ? model.id.slice(prefix.length) : model.id;
    return {
      slug: `${model.owned_by}/${upstream}`,
      provider: model.owned_by,
      upstream,
      title: model.title || upstream,
      contextLength: model.context_length ?? null,
      providerName: provider?.name || model.owned_by,
      canServeResponses: provider?.protocol === 'openai'
        || provider?.protocol === 'openai-responses'
        || Boolean(provider?.endpoints?.responses),
    };
  })
  .filter((model) => model.canServeResponses)
  .filter((model) => !allowedModels || allowedModels.has(model.slug) || allowedModels.has(model.upstream));

if (!modelEntries.length) {
  throw new Error('No Codex models were found. Check providers.json and provider credentials.');
}

const templatePath = path.resolve(String(codexConfig.catalogTemplate || '~/.codex/models.json').replace(/^~(?=$|[\\/])/, os.homedir()));
const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
if (!Array.isArray(template.models) || !template.models.length) {
  throw new Error(`No models array in Codex catalog template: ${templatePath}`);
}
const baseSlug = codexConfig.catalogBaseModel || 'deepseek-flash';
const baseModel = template.models.find((model) => model.slug === baseSlug) || template.models[0];

const generated = modelEntries.map((model, index) => {
  const entry = JSON.parse(JSON.stringify(baseModel));
  entry.slug = model.slug;
  entry.display_name = `${model.providerName} / ${model.title}`;
  entry.description = `Routed through Personal Gateway to ${model.provider}/${model.upstream}`;
  entry.priority = index + 1;
  entry.visibility = 'list';
  entry.prefer_websockets = false;
  entry.supports_search_tool = false;
  if (model.contextLength) {
    entry.context_window = model.contextLength;
    entry.max_context_window = model.contextLength;
  }
  return entry;
});

const outputCatalog = { ...template, models: generated };
const selectedModel = codexConfig.defaultModel && modelEntries.some((model) => model.slug === codexConfig.defaultModel)
  ? codexConfig.defaultModel
  : modelEntries[0].slug;

const port = Number(process.env.PGW_PROXY_PORT)
  || Number(raw.gateway?.port)
  || 8484;
const gatewayToken = String(raw.gateway?.clientToken || 'unified-local');
const providerName = 'personal-gateway';
const topLevel = {
  model: JSON.stringify(selectedModel),
  model_provider: JSON.stringify(providerName),
  model_catalog_json: JSON.stringify(catalogPath.replaceAll('\\', '/')),
  forced_login_method: '"api"',
};
const providerSection = [
  `[model_providers.${providerName}]`,
  'name = "Personal Gateway"',
  `base_url = "http://127.0.0.1:${port}/v1"`,
  'wire_api = "responses"',
  `experimental_bearer_token = ${JSON.stringify(gatewayToken)}`,
  'requires_openai_auth = false',
  'supports_websockets = false',
];

function configureCodex(existing) {
  const lines = String(existing || '').split(/\r?\n/);
  const firstTable = lines.findIndex((line) => line.trimStart().startsWith('['));
  const splitAt = firstTable < 0 ? lines.length : firstTable;
  const top = lines.slice(0, splitAt);
  const rest = lines.slice(splitAt);
  for (const [key, value] of Object.entries(topLevel)) {
    const pattern = new RegExp(`^\\s*${key}\\s*=`);
    const index = top.findIndex((line) => pattern.test(line));
    if (index >= 0) top[index] = `${key} = ${value}`;
    else top.push(`${key} = ${value}`);
  }
  const filtered = [];
  let inProvider = false;
  for (const line of rest) {
    if (line.trim() === `[model_providers.${providerName}]`) {
      inProvider = true;
      continue;
    }
    if (inProvider && line.trimStart().startsWith('[')) inProvider = false;
    if (!inProvider) filtered.push(line);
  }
  return [...top, '', ...providerSection, ...filtered].join('\n').replace(/\n+$/, '') + '\n';
}

console.log(`Codex catalog: ${catalogPath}`);
console.log(`Codex model:   ${selectedModel}`);
console.log(`Gateway URL:   http://127.0.0.1:${port}/v1`);
console.log(`Models:        ${modelEntries.length}`);
for (const model of modelEntries) {
  console.log(`  ${model.slug}  (${model.providerName})`);
}

if (dryRun) process.exit(0);

fs.mkdirSync(codexHome, { recursive: true });
fs.writeFileSync(catalogPath, JSON.stringify(outputCatalog, null, 2) + '\n', 'utf8');
const configFile = path.join(codexHome, 'config.toml');
const existing = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '';
if (fs.existsSync(configFile)) {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  fs.copyFileSync(configFile, `${configFile}.bak-${stamp}`);
}
fs.writeFileSync(configFile, configureCodex(existing), 'utf8');
console.log(`Codex config:  ${configFile}`);

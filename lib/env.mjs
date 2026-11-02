// 环境变量统一入口。2026-11 项目更名 personal_gateway：前缀 CANNBOT_ → PGW_。
// PGW_ 优先；同名旧前缀 CANNBOT_ 作过渡兜底——已装的旧 plist、外部脚本、终端里的
// 既有习惯不至于一夜失效。各模块一律经此读取，不再直接摸 process.env.CANNBOT_*。
const LEGACY_PREFIX = 'CANNBOT_';

export function envOf(name) {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (name.startsWith('PGW_')) return process.env[LEGACY_PREFIX + name.slice(4)];
  return undefined;
}

// 日志：内存环形缓冲 + 落盘 + 大小轮转。
// /admin/log 直接读内存 ring，不再每次全量读文件（旧实现每 3s 被管理台轮询全量读盘）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 日志等运行时文件默认落在 server.mjs 所在目录（运行时副本目录），随项目整体移动；
// 测试等场景可用 CANNBOT_LOG_FILE 覆盖。
const SCRIPT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LOG_FILE = process.env.CANNBOT_LOG_FILE || path.join(SCRIPT_DIR, 'proxy.log');
const LOG_MAX_BYTES = 5 * 1024 * 1024; // proxy.log 超过此大小轮转为 proxy.log.1（保留一份）
const LOG_RING_MAX = 1000;

const logRing = [];
let logFileBytes = (() => { try { return fs.statSync(LOG_FILE).size; } catch { return 0; } })();

// 启动时把已有日志尾部装进 ring，管理台刷新后历史不丢
try {
  const existing = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
  logRing.push(...existing.slice(-LOG_RING_MAX));
} catch {}

function rotateLogIfNeeded() {
  if (logFileBytes < LOG_MAX_BYTES) return;
  try {
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`); // 只保留一份旧日志
    logFileBytes = 0;
  } catch {}
}

// 单行上限：客户端可控字段（model 名、上游 SSE error message、tool id 等）会原样进日志，
// 8KB 足够一切诊断信息，超长行截断——防 ring 内存（1000 行）与 /admin/log 响应被打爆
const LOG_LINE_MAX = 8 * 1024;

export function log(...args) {
  let line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  if (line.length > LOG_LINE_MAX) line = line.slice(0, LOG_LINE_MAX) + ' …(log line truncated)';
  console.log(line);
  logRing.push(line);
  if (logRing.length > LOG_RING_MAX) logRing.shift();
  try {
    rotateLogIfNeeded(); // 先轮转再写入：触发行落在新文件里
    fs.appendFileSync(LOG_FILE, line + '\n');
    logFileBytes += Buffer.byteLength(line) + 1;
  } catch {}
}

export function tailLog(n = 80) {
  return logRing.slice(-n);
}

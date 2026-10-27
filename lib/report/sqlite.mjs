// 只读 SQLite 查询封装：spawn 系统 sqlite3（macOS 自带，3.54，零依赖），-json 输出。
// zcode / opencode 的本地库都是 WAL 模式，CLI 运行中并发读安全（reader 不阻塞）。
// 安全约定：sqlite3 CLI 没有参数绑定——调用方只允许内联 Number() 强转后的数字，
// 或过白名单正则校验的 db 内部 id；本封装只发 SELECT（不传 -readonly：无 -shm 的
// 停止态库上该 flag 可能报错，普通模式 + 纯 SELECT 同样只读）。
import { execFile } from 'node:child_process';
import fs from 'node:fs';

export function querySqlite(dbPath, sql) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(dbPath)) {
      return reject(new Error(`数据库不存在: ${dbPath}`));
    }
    execFile('/usr/bin/sqlite3', ['-json', dbPath, sql], { maxBuffer: 32 * 1024 * 1024, timeout: 30_000 }, (e, stdout) => {
      if (e) return reject(new Error(`sqlite3 查询失败: ${String(e.message).split('\n')[0]}`));
      const text = stdout.trim();
      if (!text) return resolve([]); // 无行的查询输出为空
      try { resolve(JSON.parse(text)); } catch (err) { reject(new Error(`sqlite3 -json 输出解析失败: ${err.message}`)); }
    });
  });
}

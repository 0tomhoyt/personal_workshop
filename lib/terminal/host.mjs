// opencode serve 子进程监管（设计文档 §八）：网关启动即拉起、崩溃退避重启、
// pidfile 防孤儿、僵尸轮次清扫。口令只在内存与子进程环境里，绝不落盘/进日志/回给页面。
//
// 状态机：starting → ready →（意外退出）retrying →…→ ready；连续 5 次失败 → down，
// 只有 restart() 能把 down 拉回 starting（GET /health 只读状态不触发重试——页面 15s
// 轮询健康会让「5 次后停」永远数不到）。
import fs from 'node:fs';
import { spawn as nodeSpawn, execFileSync } from 'node:child_process';
import { tryGetConfig } from '../config.mjs';
import { log as gwLog } from '../log.mjs';
import { randHex } from '../util.mjs';
import { createOpencodeClient } from './opencode.mjs';

const BACKOFF_STEPS = [1000, 2000, 5000, 15000, 60000];
const MAX_FAILURES = 5;
const RING_MAX = 50;

/**
 * 孤儿判定（纯函数，单测覆盖）：pidfile 记录的进程是否是本网关遗留的 opencode。
 * 必须同时满足：活着、命令行含 opencode、命令行带我们这次的 --port——pid 复用成
 * 别的进程、或同端口不是我们的实例，都不能杀。
 */
export function shouldKillOrphan(pidInfo, { alive, command, backendPort }) {
  if (!pidInfo || !Number.isInteger(pidInfo.pid) || pidInfo.pid <= 0) return false;
  if (!alive) return false;
  const cmd = String(command || '');
  if (!cmd.includes('opencode')) return false;
  return cmd.includes(`--port ${backendPort}`) || cmd.includes(`--port=${backendPort}`);
}

/** 日志打码（纯函数）：含口令的行把口令换成 ***，绝不让明文进环形缓冲。 */
export function redactLine(line, secret) {
  const s = String(line ?? '');
  if (!secret) return s;
  return s.split(secret).join('***');
}

function readPidFile(file) {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Number.isInteger(o?.pid) ? o : null;
  } catch { return null; }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * @param {object} opts
 * @param {() => object} [opts.getConfig] 取配置（默认 tryGetConfig，测试可注入）
 * @param {string} opts.pidFile pidfile 路径（调用方决定运行时目录）
 * @param {object} [opts.env] 子进程环境基座（默认 process.env）
 * @param {Function} [opts.spawnFn]
 * @param {Function} [opts.execFn] 同步执行外部命令（默认 execFileSync）
 */
export function createBackendHost({ getConfig = tryGetConfig, pidFile, env = process.env, spawnFn = nodeSpawn, execFn = execFileSync, now = Date.now } = {}) {
  const state = {
    value: 'down', version: null, pid: null, restarts: 0, error: null,
  };
  const ring = [];
  const listeners = new Set();
  let child = null;
  let client = null;
  let password = null;
  let bin = null;
  let failures = 0;
  let retryTimer = null;
  let stopping = false;
  let mergedPathCache = null;

  const setState = (value, error = null) => {
    state.value = value;
    state.error = error;
    for (const fn of listeners) {
      try { fn({ ...state, log: ring.slice() }); } catch { /* 监听者出错不拖垮监管 */ }
    }
  };
  const pushLog = (line) => {
    const red = redactLine(line, password);
    ring.push(red);
    if (ring.length > RING_MAX) ring.shift();
  };

  /** 合并登录 shell 的 PATH（launchd 下没有 PATH；agent 的 bash 调用也靠它）。只跑一次并缓存。 */
  function mergedPath() {
    if (mergedPathCache) return mergedPathCache;
    const shell = String(env.SHELL || '/bin/zsh');
    try {
      const loginPath = String(execFn(shell, ['-lc', 'printf "%s" "$PATH"'], { timeout: 5000, encoding: 'utf8', env: { ...env, PATH: env.PATH || '/usr/bin:/bin' } }) || '').trim();
      mergedPathCache = loginPath ? `${env.PATH || ''}:${loginPath}`.replace(/^:+/, '') : (env.PATH || '/usr/bin:/bin');
    } catch {
      mergedPathCache = env.PATH || '/usr/bin:/bin';
    }
    return mergedPathCache;
  }

  /** bin 解析：backendBin → CANNBOT_OPENCODE_BIN → 合并 PATH 里找 opencode。 */
  function resolveBin(term) {
    const candidates = [term.backendBin, env.CANNBOT_OPENCODE_BIN].map((s) => String(s || '').trim()).filter(Boolean);
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
      gwLog(`警告: gateway.terminal.backendBin 指向的文件不存在: ${c}`);
    }
    for (const dir of mergedPath().split(':')) {
      const p = `${dir}/opencode`;
      try { if (fs.statSync(p).isFile() && (fs.statSync(p).mode & 0o111)) return p; } catch {}
    }
    return null;
  }

  /** 收孤儿：pidfile 里活着的、命令行对得上的上一代子进程先杀掉再拉新。 */
  function reapOrphan(backendPort) {
    const info = readPidFile(pidFile);
    if (!info) return;
    let command = '';
    try { command = String(execFn('/bin/ps', ['-p', String(info.pid), '-o', 'command='], { timeout: 3000, encoding: 'utf8' }) || ''); } catch { return; }
    if (!shouldKillOrphan(info, { alive: command.trim().length > 0, command, backendPort })) return;
    gwLog(`终端后端: 清理上一代遗留子进程 pid=${info.pid}`);
    try { process.kill(info.pid, 'SIGTERM'); } catch {}
    const deadline = now() + 3000;
    while (processAlive(info.pid) && now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    if (processAlive(info.pid)) { try { process.kill(info.pid, 'SIGKILL'); } catch {} }
    try { fs.rmSync(pidFile, { force: true }); } catch {}
  }

  const sleep = (ms) => new Promise((r) => { retryTimer = setTimeout(r, ms); });

  /** 僵尸清扫：上一个进程里正在跑的轮次已经死了，留着 busy 只会让页面永远转圈。只清白名单内的。 */
  async function sweepZombies(c, term) {
    try {
      const statusMap = await c.sessionStatus();
      const busyIds = Object.entries(statusMap || {}).filter(([, v]) => v?.type === 'busy').map(([id]) => id);
      if (!busyIds.length) return;
      const sessions = await c.listSessions();
      const allowed = new Set(term.projects.map((p) => p.dir));
      for (const s of Array.isArray(sessions) ? sessions : []) {
        if (busyIds.includes(s.id) && allowed.has(s.directory)) {
          try { await c.abort(s.id, { directory: s.directory }); gwLog(`终端后端: 已中断遗留的僵尸轮次 ${s.id}`); } catch {}
        }
      }
    } catch (e) {
      gwLog(`终端后端: 僵尸清扫失败（不阻塞启动）: ${e.message}`);
    }
  }

  async function spawnOnce() {
    const term = getConfig().terminal;
    stopping = false;
    setState('starting');
    reapOrphan(term.backendPort);

    bin = resolveBin(term);
    if (!bin) {
      setState('down', '未找到 opencode，请设置 gateway.terminal.backendBin');
      gwLog('终端后端: 未找到 opencode 可执行文件（backendBin / CANNBOT_OPENCODE_BIN / PATH 均未命中）');
      return false;
    }

    password = randHex(16);
    const childEnv = { ...env, OPENCODE_SERVER_PASSWORD: password, PATH: mergedPath() };
    child = spawnFn(bin, ['serve', '--hostname', '127.0.0.1', '--port', String(term.backendPort)],
      { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
    state.pid = child.pid ?? null;
    client = createOpencodeClient({ baseUrl: `http://127.0.0.1:${term.backendPort}`, password });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    for (const stream of [child.stdout, child.stderr]) {
      let buf = '';
      stream?.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { pushLog(buf.slice(0, i)); buf = buf.slice(i + 1); }
      });
    }
    let exited = false;
    const onExit = (code, signal) => {
      if (exited || stopping) return;
      exited = true;
      scheduleRetry(code === null ? `信号 ${signal}` : `退出码 ${code}`);
    };
    child.on('exit', onExit);
    child.on('error', (e) => { if (!exited && !stopping) { exited = true; scheduleRetry(e.message); } });

    // 就绪探测：250ms 一次，最多 20s
    const deadline = now() + 20000;
    for (;;) {
      if (stopping) return false;
      try {
        const h = await client.health();
        state.version = h?.version ?? null;
        break;
      } catch {
        if (now() >= deadline) {
          setState('retrying', '后端 20 秒内未就绪');
          return false;
        }
        await sleep(250);
      }
    }
    if (stopping) return false;

    try {
      fs.writeFileSync(pidFile, JSON.stringify({ pid: child.pid, startedAt: now(), bin }), { mode: 0o600 });
    } catch (e) { gwLog(`终端后端: pidfile 写入失败: ${e.message}`); }

    setState('ready');
    await sweepZombies(client, term);
    return true;
  }

  async function scheduleRetry(reason) {
    failures += 1;
    state.restarts += 1;
    const portTaken = ring.some((l) => l.includes('EADDRINUSE'));
    gwLog(`终端后端子进程退出（${reason}），第 ${failures} 次失败`);
    if (failures >= MAX_FAILURES) {
      setState('down', portTaken ? '端口被占用且不是本网关启动的实例' : `连续 ${MAX_FAILURES} 次启动失败：${reason}`);
      return;
    }
    setState('retrying', `${reason}；${Math.round(BACKOFF_STEPS[Math.min(failures - 1, BACKOFF_STEPS.length - 1)] / 1000)}s 后重试`);
    await sleep(BACKOFF_STEPS[Math.min(failures - 1, BACKOFF_STEPS.length - 1)]);
    if (!stopping) await spawnOnce();
  }

  return {
    /** 拉起（enabled=false 时不动）。失败走退避，不抛出。 */
    async start() {
      const term = getConfig().terminal;
      if (!term?.enabled || child) return;
      await spawnOnce();
    },
    /** 手动重启：down 的唯一出口。重置失败计数。 */
    async restart() {
      failures = 0;
      await killChild();
      await spawnOnce();
    },
    /** 关闭：杀子进程、清 pidfile。幂等。 */
    async stop() {
      stopping = true;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      await killChild();
      try { fs.rmSync(pidFile, { force: true }); } catch {}
      setState('down');
    },
    status() {
      return { ...state, log: ring.slice(-50) };
    },
    /** 就绪时返回 opencode 客户端，否则 null。 */
    client() {
      return state.value === 'ready' ? client : null;
    },
    onEvent(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };

  async function killChild() {
    const c = child;
    child = null;
    if (!c || c.exitCode !== null || c.signalCode !== null) return;
    const died = new Promise((r) => c.once('exit', r));
    try { c.kill('SIGTERM'); } catch {}
    const timer = setTimeout(() => { try { c.kill('SIGKILL'); } catch {} }, 5000);
    await Promise.race([died, timer.then(() => {})]);
    clearTimeout(timer);
  }
}

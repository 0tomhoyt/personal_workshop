// 首屏（#home）数据组装：待办裁剪 + 每个订阅的花费与额度。
//
// 设计见 docs/superpowers/specs/2026-10-31-home-dashboard-design.md。
// 这个模块只做组装，不做 IO 决策：所有数据源都可注入（默认走真实实现），
// 测试因此不需要起进程、不需要真凭证。
//
// 两条纪律：
//   ① 标题数「所有未完成」，不是「今天动过的」——积压几天的也在里面，说「今天」是假的。
//   ② **额度查询失败绝不能让整页失败**：单家上游抽风时，卡片照常出现、花费照常显示，
//      只是环那个位置显示失败原因。
import { listTodos } from './todos.mjs';
import { getConfig } from './config.mjs';
import { providerSpend, statsSnapshot } from './stats.mjs';
import { queryQuota } from './quota.mjs';
import { runningMs, startOfLocalDay } from './tv-snapshot.mjs';
import { log } from './log.mjs';

const PENDING_LIMIT = 8;   // 待办组最多列几条（超出给「还有 N 条」）
const DONE_LIMIT = 3;      // 完成组只列今天完成的，最多几条

const URGENCY_RANK = { urgent: 0, normal: 1, someday: 2 };
const byUrgency = (a, b) => (URGENCY_RANK[a.urgency] ?? 1) - (URGENCY_RANK[b.urgency] ?? 1)
  || (Number(b.created_at) || 0) - (Number(a.created_at) || 0);

const toItem = (t, now) => ({
  id: t.id,
  title: t.title,
  status: t.status,
  urgency: t.urgency ?? 'normal',
  project: t.project ?? null,
  runningMs: runningMs(t, now),
});

export async function buildHome(opts = {}) {
  const now = opts.now ?? Date.now();
  const todos = opts.todos ?? listTodos();
  const providers = opts.providers ?? (getConfig().providers ?? []);
  const spend = opts.spend ?? ((pid) => providerSpend(pid, opts.snapshot ?? statsSnapshot()));
  const quota = opts.quota ?? queryQuota;

  const doing = todos.filter((t) => t.status === 'in_progress');
  const pending = todos.filter((t) => t.status === 'pending').sort(byUrgency);
  const todayStart = startOfLocalDay(now);
  const done = todos.filter((t) => t.status === 'done' && Number(t.completed_at) >= todayStart)
    .sort((a, b) => (Number(b.completed_at) || 0) - (Number(a.completed_at) || 0));

  const shownPending = pending.slice(0, PENDING_LIMIT);
  const shownDone = done.slice(0, DONE_LIMIT);
  const open = doing.length + pending.length;
  const shown = doing.length + shownPending.length + shownDone.length;

  // 订阅卡片只跟 config.providers 走：有花费记录但已删除的 provider（如 deepseek）
  // 不出卡片——它已经不是订阅了，把它的花费显示成一张卡只会让人以为还在用。
  const live = providers.filter((p) => p && p.enabled !== false);
  const cards = await Promise.all(live.map(async (p) => {
    const s = spend(p.id);
    let q;
    try {
      q = await quota(p);
    } catch (e) {
      // 额度是锦上添花：坏了一家不能连累整页
      log(`首屏额度查询失败 ${p.id}: ${e?.message ?? e}`);
      q = { state: 'error', at: null, error: String(e?.message ?? e), tiers: [] };
    }
    return { id: p.id, name: p.name ?? p.id, spend: s, quota: q };
  }));

  return {
    todos: {
      counts: { in_progress: doing.length, pending: pending.length, open },
      items: [...doing.map((t) => toItem(t, now)), ...shownPending.map((t) => toItem(t, now)),
        ...shownDone.map((t) => toItem(t, now))],
      hidden: Math.max(0, open - (doing.length + shownPending.length)),
      shownTotal: shown,
    },
    providers: cards,
    generatedAt: now,
  };
}

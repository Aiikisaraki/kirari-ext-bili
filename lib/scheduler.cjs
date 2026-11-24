"use strict";
// 调度器（照 dsh-bili-whale 的 scheduler 两条腿）：
//   ① setInterval 60 秒巡检 —— 兜底，启动即跑、重启可恢复；
//   ② 按 atMs 挂一次性定时器 —— 到点立刻触发，避免"窗口末尾的计划"被巡检错过。
// getHealth().lastTickAt 是"真在跑"的唯一判据。
const crypto = require('crypto');
const bio = require('./biolock.cjs');

const TICK_MS = 60000;          // 巡检间隔
const MAX_TIMER_MS = 6 * 3600000; // 太远的计划先交给巡检，与 whale 一致
const VERSION = 1;

function freshHealth() {
  return { schema: VERSION, instanceId: null, startedAt: 0, lastTickAt: 0, nextWakeAt: null, status: 'stopped', running: false };
}

// 健康文件：stateFile('biolock-health.json')；测试可用 useStore 注入内存
let store = null; // { read, write } | null
function healthFile() { return bio ? null : null; } // noop, 占位避免误用
function readHealthFile() {
  if (!store) return null;
  try { return JSON.parse(store.read()); } catch { return null; }
}
function writeHealthFile(h) {
  if (!store) return;
  try { store.write(JSON.stringify(h, null, 2)); } catch (e) { console.error('[bili-scheduler] 健康文件写入失败:', e && e.message); }
}

let timer = null;      // 巡检
let planTimer = null;  // 一次性唤醒定时器
let planTimerAt = 0;
let stopped = true;
let health = freshHealth();
let firing = false;    // tick 重入保护（巡检与定时器共用 tick，谁先到都只触发一次）
let randomOverride = null; // 测试注入的 random（start opts.random）

function getHealth() {
  return {
    lastTickAt: health.lastTickAt,
    nextWakeAt: health.nextWakeAt,
    running: health.running,
    status: health.status,
    instanceId: health.instanceId,
    startedAt: health.startedAt,
    nextPlanName: health.nextPlanName,
    lastWake: health.lastWake,
    recentIssues: health.recentIssues,
  };
}

// ---- 计划：挑选窗口 → 定时刻 → 持久化；返回 null 表示这次不醒 ----
function makePlan(now, random) {
  const t = now == null ? Date.now() : now;
  const r = typeof random === 'function' ? random : Math.random;
  const { state } = bio.load();
  if (bio.inQuietHours(t, state)) return null;
  const wins = bio.windowsOf(state);
  const win = wins.find((w) => bio.inWindow(w, t) && bio.usedCount(w.name, t, state) < w.wakes);
  if (!win) return null;
  const atMs = bio.nextWakeInWindow(win, t, r);
  if (atMs == null) return null;
  // 跳过的权利：roll <= skipChance 就把这次机会标记成 skip，仍写账
  const sc = Math.min(1, Math.max(0, Number(state.skipChance)));
  const roll = Math.min(1, Math.max(0, Number(r())));
  const action = roll < sc ? 'skip' : 'wake';
  const plan = {
    schema: VERSION,
    action, atMs,
    name: win.name, label: win.label,
    day: bio.dayKey(atMs),
    createdAt: t, skipChance: sc, roll,
  };
  bio.setPlan(plan);
  health.nextWakeAt = action === 'wake' ? atMs : null;
  writeHealthFile(health);
  return plan;
}

// 结算计划：记账（wake/skip 都占位），更新健康，返回摘要
function settlePlan(now) {
  const t = now == null ? Date.now() : now;
  const plan = bio.getPlan();
  if (!plan) return null;
  bio.mark(plan.name, plan.action, t);
  bio.clearPlan();
  health.lastWake = { name: plan.name, action: plan.action, at: t };
  health.nextWakeAt = null;
  writeHealthFile(health);
  return { name: plan.name, action: plan.action, at: t };
}

function firePlan(plan, onWake, now) {
  const t = now == null ? Date.now() : now;
  let ok = true;
  try {
    if (plan.action === 'wake' && typeof onWake === 'function') onWake({ name: plan.name, label: plan.label, atMs: plan.atMs, plan });
  } catch (e) {
    ok = false;
    console.error('[bili-scheduler] onWake 回调失败:', e && e.message);
  }
  settlePlan(t);
  return ok;
}

async function tick(onWake, now, random) {
  // 不挡在 stopped 上：定时器/巡检入口已各自判断；方便测试注入 now 直接驱动
  if (firing) return;
  firing = true;
  try {
    health.lastTickAt = now == null ? Date.now() : now;
    if (health.status === 'waiting') health.status = 'running';
    writeHealthFile(health);
    const t = now == null ? Date.now() : now;
    // 隔夜旧计划先作废（今天不再补昨天的铃），再看挂起的计划到点没有
    const plan = bio.getPlan();
    if (plan && plan.day !== bio.dayKey(t)) bio.clearPlan();
    const cur = bio.getPlan();
    if (cur) {
      if (t >= cur.atMs) { firePlan(cur, onWake, t); return; }
      return; // 计划还没到点：巡检不重复定，定时器腿到点会叫
    }
    // 没有挂起计划 → 现在判一次：该醒就立刻结算（random=0 时 atMs 即 now）
    const fresh = makePlan(t, random || randomOverride);
    if (fresh && fresh.atMs <= t) firePlan(fresh, onWake, t);
  } finally {
    firing = false;
    armPlanTimer(onWake);
  }
}

// 一次性定时器：与巡检共用 tick，谁先到都只触发一次（firing + plan 结算即清）
function armPlanTimer(onWake) {
  if (stopped) return;
  const plan = bio.getPlan();
  const at = plan ? Number(plan.atMs) : NaN;
  const armed = plan && plan.action === 'wake' && Number.isFinite(at) && at > Date.now();
  if (!armed) {
    if (planTimer) { clearTimeout(planTimer); planTimer = null; planTimerAt = 0; }
    return;
  }
  if (planTimer && planTimerAt === at) return; // 同一个目标不重复挂
  if (planTimer) { clearTimeout(planTimer); planTimer = null; }
  const delay = Math.max(0, at - Date.now()) + 50;
  if (delay > MAX_TIMER_MS) return; // 太远的先交给巡检，重启后再挂
  planTimerAt = at;
  planTimer = setTimeout(() => {
    planTimer = null; planTimerAt = 0;
    if (stopped) return;
    tick(onWake).catch((e) => console.error('[bili-scheduler] plan-timer tick 失败:', e && e.message));
  }, delay);
  if (planTimer.unref) planTimer.unref();
}

// ---- 生命周期 ----
function start(onWake, opts) {
  const o = opts || {};
  store = o.healthStore || null;
  randomOverride = typeof o.random === 'function' ? o.random : null;
  stopped = false;
  firing = false;
  health = readHealthFile() || freshHealth();
  health.instanceId = health.instanceId || crypto.randomUUID();
  health.startedAt = Date.now();
  health.status = 'waiting';
  health.running = true;
  if (store) writeHealthFile(health);
  // ① 60 秒巡检（测试可注入更短间隔）
  timer = setInterval(() => {
    if (stopped) return;
    tick(onWake).catch((e) => console.error('[bili-scheduler] tick 失败:', e && e.message));
  }, Math.max(1000, Math.floor(Number(o.tickMs) || TICK_MS)));
  if (timer.unref) timer.unref();
  // ② 按 atMs 的一次性定时器（启动即挂，重启可恢复 —— plan 持久化在 biolock.json）
  armPlanTimer(onWake);
  // 启动先跑一次（whale：启动 8 秒后先跑一次；这里立即跑，测试友好）
  tick(onWake).catch((e) => console.error('[bili-scheduler] 启动 tick 失败:', e && e.message));
  return getHealth();
}

function stop() {
  stopped = true;
  if (timer) { clearInterval(timer); timer = null; }
  if (planTimer) { clearTimeout(planTimer); planTimer = null; planTimerAt = 0; }
  health.running = false;
  health.status = 'stopped';
  writeHealthFile(health);
}

module.exports = { start, stop, tick, getHealth, makePlan, settlePlan, armPlanTimer, TICK_MS, VERSION };

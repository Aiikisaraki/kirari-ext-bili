"use strict";
// 生物钟自主醒（照 dsh-bili-whale 的 night-plan 设计）：
// Kirari 按作息时间窗随机挑时刻自己醒来 —— 不整点、有跳过的权利、安静时段不打扰。
// 纯逻辑：now / random 一律可注入；持久化坏档自愈；零 npm 依赖。
// 记账按「窗口起始日期+名称」，跳过也占位 —— 重启不复活（whale 的教训）。
const fs = require('fs');
const { stateFile } = require('./paths.cjs');

const VERSION = 1;
const MAX_WAKES_PER_WINDOW = 12;
const KEEP_DAYS = 3; // 记账只保留最近 3 天，过期自动清掉

function pad2(n) { return String(n).padStart(2, '0'); }

function defaultState() {
  return {
    windows: [{ name: 'evening', start: '20:00', end: '23:00', wakes: 1 }],
    skipChance: 0.2,
    quietStart: '23:30',
    quietEnd: '08:00',
    lastWakes: {},
    plan: null,
    version: VERSION,
  };
}

// 'HH:MM' -> 当天第几分钟；24:00 合法，其余超界一律拒绝
function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s == null ? '' : s).trim());
  if (!m) throw new Error('无效时间：' + s);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) throw new Error('无效时间：' + s);
  return h * 60 + min;
}

// 本地日历日 YYYY-MM-DD（所有比较都用本地时间，含跨午夜窗口）
function dayKey(now) {
  const d = new Date(now == null ? Date.now() : now);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// 记账键：窗口起始日期 + 名称
function keyOf(now, name) { return dayKey(now) + '|' + name; }

// 一个窗口坏掉不该拖停其它窗口：逐条校验，坏的跳过并留下「第N个窗口+字段」的可读诊断。
function normalizeWindow(w, index) {
  const at = '第 ' + (index + 1) + ' 个窗口';
  if (!w || typeof w !== 'object') return { issues: [{ at, field: 'window', message: at + '不是对象' }] };
  const issues = [];
  const name = typeof w.name === 'string' && w.name.trim() !== '' ? w.name.trim().slice(0, 40) : null;
  if (!name) issues.push({ at, field: 'name', message: at + '缺少有效 name' });
  let startMin = null;
  let endMin = null;
  for (const field of ['start', 'end']) {
    const raw = w[field];
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      issues.push({ at, field, message: at + '缺少' + (field === 'start' ? '开始' : '结束') + '时间' });
      continue;
    }
    try {
      const v = parseHM(raw);
      if (field === 'start') startMin = v; else endMin = v;
    } catch {
      issues.push({ at, field, message: at + '的' + (field === 'start' ? '开始' : '结束') + '时间无效：' + raw });
    }
  }
  if (!name || startMin === null || endMin === null) return { issues };
  const wakesRaw = Math.floor(Number(w.wakes == null ? 1 : w.wakes));
  if (!Number.isFinite(wakesRaw) || wakesRaw < 0) {
    return { issues: issues.concat([{ at, field: 'wakes', message: at + '的 wakes 无效：' + w.wakes }]) };
  }
  const wakes = Math.min(MAX_WAKES_PER_WINDOW, wakesRaw);
  // 结束 <= 开始 视为跨午夜（22:00–01:00 = 当晚 22:00 到次日 01:00）
  const endMinAbs = endMin <= startMin ? endMin + 1440 : endMin;
  const startText = String(w.start).trim();
  const endText = String(w.end).trim();
  return {
    issues,
    win: {
      name, start: startText, end: endText,
      startMin, endMin, endMinAbs, wakes,
      label: startText + '–' + endText,
    },
  };
}

function validateWindows(rawList) {
  const list = Array.isArray(rawList) ? rawList : [];
  const wins = [];
  const issues = [];
  list.forEach((w, i) => {
    const r = normalizeWindow(w, i);
    issues.push(...r.issues);
    if (r.win) wins.push(r.win);
  });
  return { windows: wins, issues, allBad: list.length > 0 && wins.length === 0 };
}

function validPlan(p) {
  return !!(p && typeof p === 'object' && Number.isFinite(Number(p.atMs)) &&
    (p.action === 'wake' || p.action === 'skip') &&
    typeof p.name === 'string' && p.name !== '' && typeof p.day === 'string');
}

// 坏配置逐条剔、好配置保留；全坏重置默认作息。返回 { state, issues }。
function normalizeState(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const issues = [];
  const state = defaultState();
  const v = validateWindows(src.windows);
  if (v.windows.length) state.windows = v.windows;
  if (v.allBad) issues.push({ at: '全部窗口', field: 'windows', message: '所有时间窗都无效，已重置为默认作息' });
  issues.push(...v.issues);

  const sc = Number(src.skipChance);
  if (src.skipChance !== undefined && !Number.isFinite(sc)) {
    issues.push({ at: '配置', field: 'skipChance', message: 'skipChance 无效：' + src.skipChance });
  }
  if (Number.isFinite(sc)) state.skipChance = Math.min(1, Math.max(0, sc));

  for (const f of ['quietStart', 'quietEnd']) {
    const rawV = src[f];
    if (rawV === undefined || rawV === null) continue; // 留默认
    try { parseHM(rawV); state[f] = String(rawV).trim(); }
    catch { issues.push({ at: '配置', field: f, message: f + ' 无效：' + rawV }); }
  }

  // 记账：key = 'YYYY-MM-DD|窗口名'，坏条目直接丢弃
  const lw = src.lastWakes && typeof src.lastWakes === 'object' && !Array.isArray(src.lastWakes) ? src.lastWakes : {};
  for (const [k, val] of Object.entries(lw)) {
    if (!/^\d{4}-\d{2}-\d{2}\|/.test(k) || !val || typeof val !== 'object') continue;
    const count = Math.floor(Number(val.count));
    if (!Number.isFinite(count) || count < 1) continue;
    state.lastWakes[k] = {
      count: Math.min(count, 99),
      lastAt: Number.isFinite(Number(val.lastAt)) ? Number(val.lastAt) : 0,
      lastAction: val.lastAction === 'skip' ? 'skip' : 'wake',
    };
  }

  // 挂起的计划只在形状完整时保留（重启可恢复）；坏计划直接丢
  if (validPlan(src.plan)) state.plan = { ...src.plan, atMs: Number(src.plan.atMs) };
  return { state, issues };
}

// ---- 持久化：stateFile('biolock.json')；测试可注入内存 store ----
const FILE = () => stateFile('biolock.json');
function fileStore() {
  return {
    read() { return fs.readFileSync(FILE(), 'utf8'); },
    write(text) { fs.writeFileSync(FILE(), text); },
  };
}
let overrideStore = null;
// 测试注入内存 store；不传参恢复默认文件 store
function useStore(s) { overrideStore = s || null; }
function activeStore() { return overrideStore || fileStore(); }

function save(state) { activeStore().write(JSON.stringify(state, null, 2)); }

// 坏档自愈：读不出 / 校验有问题的，规范化后立刻写回，下次启动就是干净状态。
function load() {
  let raw = null;
  let broken = false;
  try { raw = JSON.parse(activeStore().read()); } catch { broken = true; raw = null; }
  const { state, issues } = normalizeState(raw);
  const pruned = pruneWakes(state, Date.now());
  if (broken || issues.length || pruned > 0) {
    try { save(state); } catch (e) { console.error('[biolock] 状态写回失败:', e && e.message); }
  }
  for (const i of issues) console.error('[biolock] ' + (i.at ? i.at + ' · ' : '') + i.message);
  return { state, issues, broken };
}

// ---- 安静时段 ----
// 默认 23:30–08:00，可跨午夜；到点也不叫她。
function inQuietHours(now, cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : defaultState();
  let qs; let qe;
  try { qs = parseHM(c.quietStart); qe = parseHM(c.quietEnd); } catch { return false; }
  const d = new Date(now == null ? Date.now() : now);
  const m = d.getHours() * 60 + d.getMinutes();
  if (qs === qe) return false;
  return qe <= qs ? (m >= qs || m < qe) : (m >= qs && m < qe);
}

// ---- 时间窗 ----
function windowsOf(cfg) { return validateWindows(cfg && cfg.windows).windows; }

function toNorm(win) {
  if (win && Number.isFinite(win.startMin) && Number.isFinite(win.endMinAbs)) return win;
  const r = normalizeWindow(win, 0);
  if (!r.win) throw new Error('窗口无效');
  return r.win;
}

function windowBounds(win, now) {
  const w = toNorm(win);
  const d = new Date(now == null ? Date.now() : now);
  const base = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return { startsAt: base + w.startMin * 60000, endsAt: base + w.endMinAbs * 60000, win: w };
}

// 跨午夜窗口也认凌晨那一段（属于昨天的 occurrence）
function inWindow(win, now) {
  const t = now == null ? Date.now() : now;
  const w = toNorm(win);
  const b = windowBounds(w, t);
  if (t >= b.startsAt && t < b.endsAt) return true;
  if (w.endMinAbs > 1440) {
    const y = new Date(t);
    y.setDate(y.getDate() - 1);
    const b0 = windowBounds(w, y.getTime());
    if (t >= b0.startsAt && t < b0.endsAt) return true;
  }
  return false;
}

// 在时间窗内随机挑一个时刻（不早于 now，不落在整点上）；窗口已过返回 null。
function nextWakeInWindow(win, now, random) {
  const t = now == null ? Date.now() : now;
  const w = toNorm(win);
  // 跨午夜窗口：今天这段或昨天那段（凌晨尾巴），取还放得下的
  const days = [t];
  if (w.endMinAbs > 1440) { const y = new Date(t); y.setDate(y.getDate() - 1); days.push(y.getTime()); }
  for (const day of days) {
    const b = windowBounds(w, day);
    const from = Math.max(t, b.startsAt);
    if (from >= b.endsAt) continue;
    const r = typeof random === 'function' ? Math.min(1, Math.max(0, Number(random()))) : Math.random();
    // 连续随机挑时刻，自然不落在整点；不额外挪动 —— 保持对注入 random 的确定性
    const pick = from + Math.floor(r * Math.max(1, b.endsAt - from));
    return Math.min(pick, b.endsAt - 1);
  }
  return null;
}

// ---- 记账：key = 'YYYY-MM-DD|窗口名'，跳过也占位，重启不复活 ----
function usedCount(name, now, stateArg) {
  const st = stateArg || load().state;
  const e = st.lastWakes ? st.lastWakes[keyOf(now, name)] : null;
  const n = e ? Math.floor(Number(e.count)) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function pruneWakes(state, now) {
  const d = new Date(now == null ? Date.now() : now);
  d.setDate(d.getDate() - KEEP_DAYS);
  const cutoff = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  let removed = 0;
  for (const k of Object.keys(state.lastWakes)) if (k.slice(0, 10) < cutoff) { delete state.lastWakes[k]; removed++; }
  return removed;
}

// action: 'wake' | 'skip' —— 都算把这次机会用掉
function mark(name, action, now) {
  const t = now == null ? Date.now() : now;
  const { state } = load();
  const key = keyOf(t, name);
  const prev = state.lastWakes[key];
  const e = {
    count: (prev && Math.floor(Number(prev.count)) || 0) + 1,
    lastAt: t,
    lastAction: action === 'skip' ? 'skip' : 'wake',
  };
  state.lastWakes[key] = e;
  pruneWakes(state, t);
  save(state);
  return { key, count: e.count, lastAction: e.lastAction };
}

// ---- 判定 ----
// 详细判定：安静时段 > 窗内 > 该窗今日次数未用完 > random > skipChance
function evaluate(now, random) {
  const t = now == null ? Date.now() : now;
  const r = typeof random === 'function' ? random : Math.random;
  const { state } = load();
  if (inQuietHours(t, state)) return { wake: false, window: null, reason: 'quiet' };
  const win = windowsOf(state).find((w) => inWindow(w, t) && usedCount(w.name, t, state) < w.wakes);
  if (!win) {
    const any = windowsOf(state).find((w) => inWindow(w, t));
    return { wake: false, window: any ? any.name : null, reason: any ? 'quota-used' : 'outside-window' };
  }
  const sc = Math.min(1, Math.max(0, Number(state.skipChance)));
  const roll = Math.min(1, Math.max(0, Number(r())));
  if (roll < sc) return { wake: false, window: win.name, reason: 'skip-roll', skipChance: sc, roll };
  return { wake: true, window: win.name, reason: 'ok', skipChance: sc, roll };
}

function shouldWake(now, random) { return evaluate(now, random).wake; }

// ---- 挂起的计划（调度器用；持久化在 state.plan，重启可恢复）----
function getPlan(stateArg) {
  const st = stateArg || load().state;
  return validPlan(st.plan) ? st.plan : null;
}
// plan=null 清掉；非法 plan 也按 null 存
function setPlan(plan) {
  const { state } = load();
  state.plan = validPlan(plan) ? { ...plan, atMs: Number(plan.atMs) } : null;
  save(state);
  return state.plan;
}
function clearPlan() { return setPlan(null); }

module.exports = {
  VERSION,
  parseHM, dayKey, keyOf, defaultState,
  normalizeWindow, validateWindows, normalizeState,
  useStore, load, save,
  inQuietHours, windowsOf, inWindow, windowBounds, nextWakeInWindow,
  usedCount, mark, evaluate, shouldWake,
  validPlan, getPlan, setPlan, clearPlan,
};

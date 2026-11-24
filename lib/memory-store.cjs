"use strict";
// ── 有来源的可审计记忆（照 dsh-bili-whale 的记忆设计）──────────────
//
// 每条记忆 = 一个可核对的引用：她在哪个视频（bvid）、读到的原文片段（excerpt）、
// 她自己的感受（takeaway）。记忆有生命周期，被召回的活下来，无人想起的归档
// （不删除——归档文件就是审计底账）。
//
//   note = { id, bvid, title, excerpt(≤300字原文), takeaway(≤200字感受),
//            at, kind: 'observation'|'question'|'reaction',
//            lifecycle: 'current'|'recent'|'stable'|'expired',
//            recalled, lastRecalledAt }
//
// 生命周期流转（全部按注入的 now 计算）：
//   current  写入后 7 天内
//   recent   7～90 天（未归档前保持 recent，等 prune 结算）
//   stable   被召回 ≥3 次的重要记忆；stable 不因时间倒退降级，
//            但 90 天无召回仍会过期（稳定 ≠ 永生）
//   expired  距「创建或最近一次召回」超过 90 天 → prune 时移入
//            memory-archive.json（带 archivedAt，可审计，不删）
//
// 隐私红线：写入前逐字段过 lib/scrub.cjs 的 isSafeBiliMemory，
// 命中人名/账号/联系方式 → 整条拒绝，不落盘。
//
// 本文件纯逻辑：所有函数接受 now 注入；stateFile 走 paths.stateFile 动态调用，
// 测试可整体替换到临时目录，不碰真实 data/。

const fs = require('fs');
const paths = require('./paths.cjs');
const { isSafeBiliMemory } = require('./scrub.cjs');

const NOTES_FILE = 'notes.json';
const ARCHIVE_FILE = 'memory-archive.json';

const CURRENT_MS = 7 * 86400e3;    // current 窗口
const RECENT_MS = 30 * 86400e3;    // recent 窗口（8~30 天仍记 recent，30 天外等 prune）
const EXPIRED_MS = 90 * 86400e3;   // 90 天无召回 → 过期
const STABLE_RECALLS = 3;          // 召回 ≥3 次 → stable
const MAX_NOTES = 500;             // 活跃记忆上限（超出的最旧条目移入归档，不销毁）
const KINDS = ['observation', 'question', 'reaction'];
const LIFECYCLES = ['current', 'recent', 'stable', 'expired'];

// ── 存储 ─────────────────────────────────────────────────────────

/** 读一个 JSON 文件；损坏时把坏档改名留底（.corrupt-<ts>），按空档处理（自愈） */
function readJson(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf-8'); } catch { return null; } // 不存在 = 空
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : null;
  } catch {
    try { fs.copyFileSync(file, file + '.corrupt-' + Date.now()); } catch {}
    return null;
  }
}

function loadNotes(now) {
  const v = readJson(paths.stateFile(NOTES_FILE));
  const raw = v && Array.isArray(v.notes) ? v.notes : [];
  // 逐条消毒：字段不合法的丢弃；lifecycle 过期/非法的按 now 重算
  const notes = [];
  for (const n of raw) {
    const fixed = sanitizeNote(n, now);
    if (fixed) notes.push(fixed);
  }
  return { notes };
}

function loadArchive() {
  const v = readJson(paths.stateFile(ARCHIVE_FILE));
  return v && Array.isArray(v.archive) ? v.archive : [];
}

function saveJson(file, v) {
  try {
    paths.stateFile(ARCHIVE_FILE); // 顺带确保 data/ 目录存在
    fs.writeFileSync(file, JSON.stringify(v, null, 2), { mode: 0o600 });
    return true;
  } catch { return false; }
}

function persistNotes(store) { return saveJson(paths.stateFile(NOTES_FILE), { notes: store.notes }); }
function persistArchive(archive) { return saveJson(paths.stateFile(ARCHIVE_FILE), { archive }); }

// ── 生命周期 ─────────────────────────────────────────────────────

/** 按年龄与召回数重算 lifecycle（stable 不倒退；expired 只属于归档件） */
function lifecycleOf(note, now) {
  if (note.lifecycle === 'stable' || (note.recalled || 0) >= STABLE_RECALLS) return 'stable';
  const age = now - note.at;
  if (age <= CURRENT_MS) return 'current';
  return 'recent'; // 7~90 天都算 recent，最终去留由 prune 按召回时间结算
}

/** 距上次「被想起」（创建或召回）多久了 */
function lastTouched(note) { return Math.max(note.at || 0, note.lastRecalledAt || 0); }

/** 单条消毒：字段修正 + lifecycle 重算；缺 id/at/bvid 的整条丢弃 */
function sanitizeNote(n, now) {
  if (!n || typeof n !== 'object') return null;
  const id = String(n.id || '').trim();
  const bvid = String(n.bvid || '').trim();
  const at = Number(n.at);
  if (!id || !bvid || !Number.isFinite(at)) return null;
  const out = {
    id, bvid,
    title: String(n.title || '').slice(0, 120),
    excerpt: String(n.excerpt || '').slice(0, 300),
    takeaway: String(n.takeaway || '').slice(0, 200),
    at,
    kind: KINDS.includes(n.kind) ? n.kind : 'observation',
    lifecycle: LIFECYCLES.includes(n.lifecycle) ? n.lifecycle : 'current',
    recalled: Number.isFinite(Number(n.recalled)) ? Math.max(0, Math.floor(Number(n.recalled))) : 0,
  };
  if (Number.isFinite(Number(n.lastRecalledAt))) out.lastRecalledAt = Number(n.lastRecalledAt);
  if (out.lifecycle === 'expired') out.lifecycle = 'current'; // 活跃文件里不该有 expired，重算
  out.lifecycle = lifecycleOf(out, now);
  return out;
}

// ── 写入 ─────────────────────────────────────────────────────────

/**
 * 记一条带来源的见闻。写入前逐字段过隐私闸门，命中红线整条拒绝。
 * @param {object} args - { bvid, title, excerpt, takeaway, kind }
 * @param {object} [opts] - { now=Date.now(), knownPersons=[] }
 * @returns {{ok:boolean, note?:object, reason?:string}}
 */
function add(args = {}, opts = {}) {
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  if (opts.knownPersons) { try { require('./scrub.cjs').setKnownPersons(opts.knownPersons); } catch {} }

  const bvid = String(args.bvid || '').trim();
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return { ok: false, reason: 'bvid 格式不对' };
  const title = String(args.title || '').trim().slice(0, 120);
  const excerpt = String(args.excerpt || '').trim().slice(0, 300);
  const takeaway = String(args.takeaway || '').trim().slice(0, 200);
  if (!excerpt && !takeaway) return { ok: false, reason: 'excerpt/takeaway 至少要有一个' };
  const kind = KINDS.includes(args.kind) ? args.kind : 'observation';

  // 隐私红线：三个文本字段逐个校验，任何一个命中都整条拒绝
  for (const [field, text] of [['title', title], ['excerpt', excerpt], ['takeaway', takeaway]]) {
    if (text && !isSafeBiliMemory(text)) return { ok: false, reason: 'privacy_blocked:' + field };
  }

  const store = loadNotes(now);
  const note = {
    id: 'n_' + now.toString(36) + Math.random().toString(36).slice(2, 6),
    bvid, title, excerpt, takeaway, at: now, kind,
    lifecycle: 'current', recalled: 0,
  };
  note.lifecycle = lifecycleOf(note, now);
  store.notes.push(note);

  // 超限：最旧的溢出条目移入归档（不销毁，可审计）
  let overflowed = 0;
  if (store.notes.length > MAX_NOTES) {
    const overflow = store.notes.slice(0, store.notes.length - MAX_NOTES)
      .map((n) => ({ ...n, lifecycle: 'expired', archivedAt: now, archiveReason: 'overflow' }));
    const archive = loadArchive();
    archive.push(...overflow);
    persistArchive(archive);
    store.notes = store.notes.slice(-MAX_NOTES);
    overflowed = overflow.length;
  }
  persistNotes(store);
  return { ok: true, note, overflowed };
}

// ── 召回 ─────────────────────────────────────────────────────────

/** 关键词切分：空白 / 中英文逗号 / 顿号 / 分号都算分隔 */
function splitKeywords(input) {
  const list = String(input || '').split(/[\s,，、;；]+/).map((s) => s.trim()).filter(Boolean);
  return [...new Set(list)];
}

/**
 * 按关键词召回：任一关键词命中 title/excerpt/takeaway 即算命中。
 * 命中条目 recalled++（驱动 stable 晋升与 90 天无召回结算），并刷新 lastRecalledAt。
 * @param {string|string[]} keywords
 * @param {number} [now=Date.now()]
 * @returns {Array<object>} 命中的记忆（新→旧），附 matched 命中的关键词
 */
function recall(keywords, now = Date.now()) {
  const keys = Array.isArray(keywords) ? splitKeywords(keywords.join(' ')) : splitKeywords(keywords);
  if (!keys.length) return [];
  const store = loadNotes(now);
  const hits = [];
  let dirty = false;
  for (const n of store.notes) {
    const hay = n.title + '\n' + n.excerpt + '\n' + n.takeaway;
    const matched = keys.filter((k) => hay.includes(k));
    if (!matched.length) continue;
    n.recalled += 1;
    n.lastRecalledAt = now;
    n.lifecycle = lifecycleOf(n, now);
    dirty = true;
    hits.push({ ...n, matched });
  }
  if (dirty) persistNotes(store);
  return hits.sort((a, b) => b.at - a.at);
}

// ── 结算与统计 ───────────────────────────────────────────────────

/**
 * 结算生命周期：超过 90 天无召回的移入 memory-archive.json（lifecycle=expired，
 * 带 archivedAt，不删除——归档就是审计底账）；其余按 now 刷新 lifecycle。
 * @param {number} [now=Date.now()]
 * @returns {{archived:number, kept:number, current:number, recent:number, stable:number}}
 */
function prune(now = Date.now()) {
  const store = loadNotes(now);
  const keep = [];
  const expired = [];
  for (const n of store.notes) {
    if (now - lastTouched(n) > EXPIRED_MS) expired.push(n);
    else { n.lifecycle = lifecycleOf(n, now); keep.push(n); }
  }
  let archived = 0;
  if (expired.length) {
    const archive = loadArchive();
    archive.push(...expired.map((n) => ({ ...n, lifecycle: 'expired', archivedAt: now, archiveReason: 'no_recall' })));
    if (persistArchive(archive)) archived = expired.length; // 归档写失败则留在活跃文件，下轮再试
  }
  store.notes = keep;
  persistNotes(store);
  const st = { current: 0, recent: 0, stable: 0 };
  for (const n of store.notes) st[n.lifecycle]++;
  return { archived, kept: store.notes.length, ...st };
}

/**
 * 按 lifecycle 统计（含归档件，不打扰存储）
 * @param {number} [now=Date.now()]
 * @returns {{total,current,recent,stable,expired}}
 */
function stats(now = Date.now()) {
  const store = loadNotes(now);
  const out = { current: 0, recent: 0, stable: 0, expired: 0 };
  for (const n of store.notes) out[lifecycleOf(n, now)]++;
  out.expired = loadArchive().length;
  out.total = out.current + out.recent + out.stable + out.expired;
  return out;
}

module.exports = { add, recall, prune, stats, splitKeywords, lifecycleOf, sanitizeNote, NOTES_FILE, ARCHIVE_FILE, CURRENT_MS, RECENT_MS, EXPIRED_MS, STABLE_RECALLS, MAX_NOTES };

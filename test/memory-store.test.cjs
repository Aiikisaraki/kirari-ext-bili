"use strict";
// memory-store 测试：生命周期流转、召回计数、prune 归档、坏档自愈、隐私拦截。
// 全部用注入的 now + 临时目录，不碰真实 data/、不发网络请求。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 每个测试拿到独立临时目录：替换 paths.stateFile，避免互相污染
function freshStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-mem-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = require('../lib/paths.cjs');
  const orig = paths.stateFile;
  paths.stateFile = (name) => path.join(dir, name);
  t.after(() => { paths.stateFile = orig; });
  // 清掉 require 缓存保证干净加载
  delete require.cache[require.resolve('../lib/memory-store.cjs')];
  return require('../lib/memory-store.cjs');
}

const DAY = 86400e3;
const T0 = new Date('2026-01-01T00:00:00Z').getTime();
function noteArgs(i = 1, over = {}) {
  return { bvid: 'BV1Ab411e7' + String(i).padStart(2, '0'), title: '视频' + i, excerpt: '讲量子计算的片段' + i, takeaway: '我觉得涨知识了' + i, ...over };
}

test('add：生成完整 note 结构，新记忆是 current', (t) => {
  const store = freshStore(t);
  const r = store.add(noteArgs(1), { now: T0 });
  assert.equal(r.ok, true);
  const n = r.note;
  assert.equal(n.bvid, 'BV1Ab411e701');
  assert.equal(n.title, '视频1');
  assert.equal(n.excerpt, '讲量子计算的片段1');
  assert.equal(n.takeaway, '我觉得涨知识了1');
  assert.equal(n.kind, 'observation');
  assert.equal(n.lifecycle, 'current');
  assert.equal(n.recalled, 0);
  assert.equal(n.at, T0);
  assert.match(n.id, /^n_/);
});

test('add：bvid 非法 / 内容为空 → 拒绝', (t) => {
  const store = freshStore(t);
  assert.equal(store.add({ bvid: 'bad', excerpt: 'x' }, { now: T0 }).ok, false);
  assert.equal(store.add(noteArgs(9, { bvid: 'BVxx000000' }), { now: T0 }).ok, false, 'BV 后不足 10 位应拒绝'); // 9 位
  assert.equal(store.add({ bvid: 'BV1Ab411e799', title: '', excerpt: '', takeaway: '' }, { now: T0 }).ok, false);
});

test('隐私红线：人名昵称/手机号/邮箱/微信号 → 整条拒绝，不落盘', (t) => {
  const store = freshStore(t);
  const bad = [
    noteArgs(1, { excerpt: '小王今天发了个视频' }),
    noteArgs(2, { takeaway: '联系方式是 13812345678' }),
    noteArgs(3, { excerpt: '邮箱 foo@example.com 保留' }),
    noteArgs(4, { takeaway: '加我微信详聊' }),
  ];
  for (const b of bad) {
    const r = store.add(b, { now: T0 });
    assert.equal(r.ok, false, '应被拦截: ' + JSON.stringify(b));
    assert.match(r.reason, /^privacy_blocked:/);
  }
  assert.equal(store.stats(T0).total, 0, '被拒内容不落盘');
});

test('生命周期流转：current(7d) → recent(30d)；被召回≥3次 → stable', (t) => {
  const store = freshStore(t);
  store.add(noteArgs(1), { now: T0 }); // 片段含「量子计算」
  store.add(noteArgs(2, { excerpt: '讲深海生物的片段2' }), { now: T0 });
  assert.equal(store.stats(T0).current, 2);
  assert.equal(store.stats(T0 + 6 * DAY).current, 2);
  assert.equal(store.stats(T0 + 7 * DAY).current, 2, '恰满 7 天仍在 current 窗口内');
  assert.equal(store.stats(T0 + 7 * DAY + 1).current, 0);
  assert.equal(store.stats(T0 + 7 * DAY + 1).recent, 2);
  // 召回第 1 条 3 次 → stable（「量子计算」只命中它，note2 已改内容）
  store.recall(['量子计算'], T0 + 8 * DAY);
  store.recall(['量子计算'], T0 + 9 * DAY);
  assert.equal(store.stats(T0 + 9 * DAY).stable, 0, '两次召回还不到 stable');
  store.recall(['量子计算'], T0 + 10 * DAY);
  assert.equal(store.stats(T0 + 10 * DAY).stable, 1, '第三次召回晋升 stable');
  assert.equal(store.stats(T0 + 10 * DAY).recent, 1, '另一条还是 recent');
});

test('stable 不因时间倒退降级（但仍受 90 天无召回约束）', (t) => {
  const store = freshStore(t);
  store.add(noteArgs(1), { now: T0 });
  for (let d = 1; d <= 3; d++) store.recall(['量子'], T0 + d * DAY);
  assert.equal(store.stats(T0 + 40 * DAY).stable, 1, '40 天仍是 stable');
  assert.equal(store.stats(T0 + 60 * DAY).stable, 1, '60 天仍是 stable');
});

test('recall：关键词命中计数 +1，未命中的不动', (t) => {
  const store = freshStore(t);
  store.add(noteArgs(1, { excerpt: '猫咪踩键盘的片段' }), { now: T0 });
  store.add(noteArgs(2, { excerpt: '量子纠错很难' }), { now: T0 });
  const hits = store.recall(['猫咪'], T0 + DAY);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].matched, ['猫咪']);
  assert.equal(hits[0].recalled, 1);
  assert.equal(hits[0].lastRecalledAt, T0 + DAY);
  // 落盘验证：另一条 recalled 仍为 0
  const raw = JSON.parse(fs.readFileSync(require('../lib/paths.cjs').stateFile('notes.json'), 'utf-8'));
  assert.equal(raw.notes.find((n) => n.id !== hits[0].id).recalled, 0);
});

test('recall：多个关键词 / 数组入参 / 无命中', (t) => {
  const store = freshStore(t);
  store.add(noteArgs(1, { title: 'AI 教程', excerpt: '讲大模型' }), { now: T0 });
  assert.equal(store.recall(['大模型', '不存在词'], T0).length, 1);
  assert.equal(store.recall(['AI'], T0).length, 1);
  assert.equal(store.recall([], T0).length, 0);
  assert.equal(store.recall('   ', T0).length, 0);
});

test('prune：90 天无召回 → 移入 memory-archive.json（lifecycle=expired，带 archivedAt）', (t) => {
  const store = freshStore(t);
  store.add(noteArgs(1), { now: T0 });
  store.add(noteArgs(2), { now: T0 + 10 * DAY });
  // T0+95 天：第 1 条（最后被想起 = T0）已超 90 天；第 2 条（T0+10d）刚 85 天
  const r = store.prune(T0 + 95 * DAY);
  assert.equal(r.archived, 1);
  assert.equal(r.kept, 1);
  const paths = require('../lib/paths.cjs');
  const arch = JSON.parse(fs.readFileSync(paths.stateFile('memory-archive.json'), 'utf-8'));
  assert.equal(arch.archive.length, 1);
  assert.equal(arch.archive[0].lifecycle, 'expired');
  assert.equal(arch.archive[0].archivedAt, T0 + 95 * DAY);
  assert.equal(arch.archive[0].archiveReason, 'no_recall');
  // 召回可以续命：先召回再结算
  store.recall(['量子'], T0 + 100 * DAY); // 第 2 条续命
  const r2 = store.prune(T0 + 200 * DAY);
  assert.equal(r2.archived, 1);
  assert.equal(store.stats(T0 + 200 * DAY).expired, 2);
});

test('prune：召回过的记忆按 lastRecalledAt 结算', (t) => {
  const store = freshStore(t);
  store.add(noteArgs(1), { now: T0 });
  store.recall(['量子'], T0 + 80 * DAY); // 80 天时想了起来
  const r = store.prune(T0 + 100 * DAY); // 距上次召回仅 20 天 → 留下
  assert.equal(r.archived, 0);
  assert.equal(r.kept, 1);
});

test('坏档自愈：notes.json 损坏 → 留底 .corrupt-*，按空档继续工作', (t) => {
  const store = freshStore(t);
  const paths = require('../lib/paths.cjs');
  fs.writeFileSync(paths.stateFile('notes.json'), '{ this is not json !!!', 'utf-8');
  const r = store.add(noteArgs(1), { now: T0 });
  assert.equal(r.ok, true, '坏档后仍能写入');
  const files = fs.readdirSync(paths.stateFile('.')).filter((f) => f.startsWith('notes.json.corrupt-'));
  assert.equal(files.length, 1, '坏档应留底');
  assert.match(fs.readFileSync(paths.stateFile(files[0]), 'utf-8'), /not json/);
  assert.equal(store.stats(T0).total, 1);
});

test('坏档自愈：archive 损坏不影响 notes 读写', (t) => {
  const store = freshStore(t);
  const paths = require('../lib/paths.cjs');
  fs.writeFileSync(paths.stateFile('memory-archive.json'), 'garbage', 'utf-8');
  store.add(noteArgs(1), { now: T0 });
  const r = store.prune(T0 + 100 * DAY);
  assert.equal(r.archived, 1, '坏归档自愈后照常归档');
  assert.equal(store.stats(T0 + 100 * DAY).expired, 1);
});

test('stats：归档计入 expired，total = 活跃 + 归档', (t) => {
  const store = freshStore(t);
  store.add(noteArgs(1), { now: T0 }); // 片段含「量子计算1」
  store.add(noteArgs(2, { excerpt: '讲深海生物的片段2' }), { now: T0 });
  // 第 1 条召回 3 次 → stable；最后一次在 T0+50d，T0+95d 时距上次召回 45 天 < 90 → 留下
  for (const d of [1, 2, 50]) store.recall(['量子计算'], T0 + d * DAY);
  store.prune(T0 + 95 * DAY); // 第 2 条 95 天无召回 → 归档
  const s = store.stats(T0 + 95 * DAY);
  assert.deepEqual({ total: s.total, current: s.current, recent: s.recent, stable: s.stable, expired: s.expired }, { total: 2, current: 0, recent: 0, stable: 1, expired: 1 });
});

test('持久化经状态文件（notes.json），不入内存即可跨调用读取', (t) => {
  const store = freshStore(t);
  store.add(noteArgs(1), { now: T0 });
  delete require.cache[require.resolve('../lib/memory-store.cjs')];
  const store2 = require('../lib/memory-store.cjs');
  assert.equal(store2.stats(T0 + DAY).total, 1, '重载模块后仍在（真落盘）');
});

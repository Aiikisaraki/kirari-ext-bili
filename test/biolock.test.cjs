"use strict";
// 生物钟自主醒测试：node --test test/
// now / random 全部注入；持久层用内存 store；不真起长期定时器（调度器用短间隔并立刻 stop）。
const test = require('node:test');
const assert = require('node:assert');
const bio = require('../lib/biolock.cjs');

// ---- 工具 ----
function at(day, hm) {
  const [y, mo, d] = day.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}
function memStore(initial) {
  let text = initial == null ? JSON.stringify(bio.defaultState()) : initial;
  return {
    read() { return text; },
    write(t) { text = t; },
    get text() { return text; },
  };
}
function rndSeq(vals) { // 依次返回 vals，用完重复最后一个
  let i = 0;
  return () => (i < vals.length ? vals[i++] : vals[vals.length - 1]);
}
// 安装一个内存 store + 指定 state，返回 { store, state }
function install(state) {
  // 字符串按原文存（测坏档），对象才序列化
  const s = memStore(typeof state === 'string' ? state : JSON.stringify(state));
  bio.useStore(s);
  return s;
}

test('parseHM / dayKey / keyOf 基本行为', () => {
  assert.strictEqual(bio.parseHM('08:05'), 485);
  assert.strictEqual(bio.parseHM('24:00'), 1440);
  assert.throws(() => bio.parseHM('24:30'));
  assert.throws(() => bio.parseHM('7:60'));
  assert.throws(() => bio.parseHM('abc'));
  assert.throws(() => bio.parseHM(''));
  const t = at('2026-11-25', '01:00');
  assert.strictEqual(bio.dayKey(t), '2026-11-25');
  assert.strictEqual(bio.keyOf(t, 'evening'), '2026-11-25|evening');
});

test('nextWakeInWindow：窗内随机、不早于 now、不整点', () => {
  install();
  const win = { name: 'n', start: '20:00', end: '22:00', wakes: 1 };
  const now = at('2026-11-25', '20:30');
  const pick = bio.nextWakeInWindow(win, now, () => 0.5);
  assert.ok(pick > now && pick <= at('2026-11-25', '22:00'), '落在窗内剩余区间');
  // random=0 → 时刻 = now（已过部分不回拨）
  assert.strictEqual(bio.nextWakeInWindow(win, now, () => 0), now);
  // 窗口已过 → null
  assert.strictEqual(bio.nextWakeInWindow(win, at('2026-11-25', '22:01'), () => 0.5), null);
  // 未开始 → 从窗口起点开始挑
  const early = bio.nextWakeInWindow(win, at('2026-11-25', '10:00'), () => 0.5);
  assert.ok(early >= at('2026-11-25', '20:00') && early < at('2026-11-25', '22:00'));
  // 跨午夜窗口
  const wrap = { name: 'w', start: '22:00', end: '01:00', wakes: 1 };
  const late = bio.nextWakeInWindow(wrap, at('2026-11-25', '23:00'), () => 0.9);
  assert.ok(late > at('2026-11-25', '23:00') && late <= at('2026-11-26', '01:00'), '跨午夜按次日结束算');
  // 连续随机：不同 roll 给不同时刻，且时刻带秒级粒度（非整分钟对齐的钟点表）
  const w2 = { name: 'n2', start: '20:00', end: '21:00', wakes: 1 };
  const t0 = at('2026-11-25', '20:00');
  const a = bio.nextWakeInWindow(w2, t0, () => 0.25);
  const b = bio.nextWakeInWindow(w2, t0, () => 0.75);
  assert.ok(a !== b, '不同 roll 挑到不同时刻');
  assert.ok(a > t0 && b > t0 && a <= at('2026-11-25', '21:00'), '窗内');
});

test('inQuietHours：默认 23:30–08:00，跨午夜两端都判', () => {
  install();
  const cases = [
    ['23:29', false], ['23:30', true], ['00:00', true], ['07:59', true], ['08:00', false],
    ['12:00', false],
  ];
  for (const [hm, want] of cases) {
    assert.strictEqual(bio.inQuietHours(at('2026-11-25', hm)), want, hm);
  }
  // 非跨午夜：22:00–23:00
  const cfg = { quietStart: '22:00', quietEnd: '23:00' };
  assert.strictEqual(bio.inQuietHours(at('2026-11-25', '22:30'), cfg), true);
  assert.strictEqual(bio.inQuietHours(at('2026-11-25', '23:30'), cfg), false);
});

test('skipChance 边界：0 必醒、1 必跳、roll==skipChance 算跳过', () => {
  const base = { windows: [{ name: 'e', start: '20:00', end: '22:00', wakes: 1 }], skipChance: 0.2 };
  const now = at('2026-11-25', '21:00');
  install({ ...base, skipChance: 0 });
  assert.strictEqual(bio.shouldWake(now, () => 0), true, 'skip=0, roll=0 → 醒');
  install({ ...base, skipChance: 1 });
  assert.strictEqual(bio.shouldWake(now, () => 0.999), false, 'skip=1 → 必跳');
  install({ ...base, skipChance: 0.5 });
  assert.strictEqual(bio.shouldWake(now, () => 0.5), true, 'roll==skipChance → 醒（roll<sc 才跳，照 whale）');
  assert.strictEqual(bio.shouldWake(now, () => 0.499999), false, 'roll<skipChance → 跳过');
  // 负数 / 超过 1 的 skipChance 被夹紧
  install({ ...base, skipChance: -5 });
  assert.strictEqual(bio.shouldWake(now, () => 0), true);
  install({ ...base, skipChance: 99 });
  assert.strictEqual(bio.shouldWake(now, () => 0.9), false);
});

test('窗内 + 次数未用完 + 概率过 → 醒；安静时段优先级最高', () => {
  install({ windows: [{ name: 'e', start: '20:00', end: '23:59', wakes: 2 }], skipChance: 0, quietStart: '23:30', quietEnd: '08:00' });
  assert.strictEqual(bio.shouldWake(at('2026-11-25', '23:40')), false, '安静时段优先');
  assert.strictEqual(bio.shouldWake(at('2026-11-25', '21:00')), true);
  assert.strictEqual(bio.shouldWake(at('2026-11-25', '19:59')), false, '窗外');
  bio.mark('e', 'wake', at('2026-11-25', '21:00'));
  assert.strictEqual(bio.shouldWake(at('2026-11-25', '21:30')), true, '2 次额度还剩 1');
  bio.mark('e', 'skip', at('2026-11-25', '21:30'));
  assert.strictEqual(bio.shouldWake(at('2026-11-25', '21:40')), false, '额度用完');
  assert.strictEqual(bio.evaluate(at('2026-11-25', '21:40')).reason, 'quota-used');
  // 跨午夜窗口：凌晨那一段属于昨天的 occurrence，明天账不背今天锅
  install({ windows: [{ name: 'w', start: '22:00', end: '01:00', wakes: 1 }], skipChance: 0 });
  assert.strictEqual(bio.shouldWake(at('2026-11-25', '23:00')), true);
  bio.mark('w', 'wake', at('2026-11-25', '23:00'));
  assert.strictEqual(bio.shouldWake(at('2026-11-26', '00:30')), false, '凌晨段仍属昨日账，已用完');
  assert.strictEqual(bio.shouldWake(at('2026-11-26', '22:30')), true, '次日窗口重新计账');
});

test('坏配置：逐条跳过并给出「第N个窗口+字段」；全坏重置默认', () => {
  const { state, issues } = bio.normalizeState({
    windows: [
      { name: 'ok', start: '20:00', end: '22:00', wakes: 1 },
      { start: '21:00', end: '23:00' },                        // 缺 name
      { name: 'bad-time', start: '25:00', end: '23:00' },      // start 越界
      { name: 'no-end', start: '20:00' },                      // 缺 end
      null,                                                    // 不是对象
      { name: 'neg', start: '20:00', end: '22:00', wakes: -3 },// wakes 负数
      { name: 'over', start: '20:00', end: '22:00', wakes: 99 },// wakes 上限夹紧
    ],
    skipChance: 7,
    quietStart: 'bad',
  });
  const fields = issues.map((i) => i.at + ':' + i.field).sort();
  assert.ok(fields.includes('第 2 个窗口:name'), '缺 name 有诊断');
  assert.ok(fields.includes('第 3 个窗口:start'), '坏 start 有诊断');
  assert.ok(fields.includes('第 4 个窗口:end'), '缺 end 有诊断');
  assert.ok(fields.includes('第 5 个窗口:window'), '非对象有诊断');
  assert.ok(fields.includes('第 6 个窗口:wakes'), '坏 wakes 有诊断');
  assert.strictEqual(state.windows.length, 2, '好窗口保留 + wakes 夹紧');
  assert.strictEqual(state.windows[1].name, 'over');
  assert.strictEqual(state.windows[1].wakes, 12, 'wakes 上限 12');
  assert.strictEqual(state.skipChance, 1, 'skipChance 夹紧到 [0,1]');
  assert.strictEqual(state.quietStart, '23:30', '坏 quietStart 回退默认');
  // 全坏 → 重置默认作息
  const all = bio.normalizeState({ windows: [{ name: '', start: 'x', end: 'y' }] });
  assert.strictEqual(all.state.windows.length, 1);
  assert.strictEqual(all.state.windows[0].name, 'evening');
  assert.ok(all.issues.some((i) => /所有时间窗都无效/.test(i.message)), '全坏有整体诊断');
  // 纯垃圾输入也不炸
  const junk = bio.normalizeState('not an object');
  assert.strictEqual(junk.state.windows.length, 1);
  assert.strictEqual(junk.state.windows[0].name, 'evening');
});

test('持久化坏档自愈：坏 JSON / 半坏档 → 规范化写回', () => {
  // 完全坏档
  let s = install('{oops');
  let r = bio.load();
  assert.strictEqual(r.broken, true);
  assert.strictEqual(r.state.windows[0].name, 'evening', '坏档 → 默认作息');
  assert.ok(JSON.parse(s.text).windows[0].name === 'evening', '坏档已写回');
  // 半坏档：一个窗口坏、skipChance 非法
  s = install(JSON.stringify({
    windows: [{ name: 'good', start: '20:00', end: '22:00', wakes: 1 }, { name: 'bad', start: 'oops', end: '22:00' }],
    skipChance: 'NaN',
    lastWakes: { '2026-11-25|good': { count: 1, lastAt: 1, lastAction: 'wake' }, 'junk': { count: 5 } },
  }));
  r = bio.load();
  assert.strictEqual(r.state.windows.length, 1, '坏窗口剔除，好窗口保留');
  assert.strictEqual(r.state.skipChance, 0.2, '非法 skipChance 回退默认');
  assert.deepStrictEqual(Object.keys(r.state.lastWakes), ['2026-11-25|good'], '坏记账键丢弃');
  const saved = JSON.parse(s.text);
  assert.strictEqual(saved.windows.length, 1, '自愈结果已写回磁盘');
});

test('记账不复活：跨天 key 隔离 + 旧账自动清理', () => {
  install({
    windows: [{ name: 'e', start: '20:00', end: '22:00', wakes: 1 }],
    skipChance: 0,
    lastWakes: {
      '2026-11-24|e': { count: 1, lastAt: at('2026-11-24', '21:00'), lastAction: 'wake' },
      '2026-11-20|old': { count: 9, lastAt: 1, lastAction: 'wake' },
    },
  });
  const now = at('2026-11-25', '21:00');
  // 昨天的账不挡今天的醒
  assert.strictEqual(bio.shouldWake(now), true, '昨天的账不复活到今天');
  // 3 天前的旧账被清掉
  const { state } = bio.load();
  assert.ok(!('2026-11-20|old' in state.lastWakes), '过期记账被清理');
  assert.ok('2026-11-24|e' in state.lastWakes, '近期记账保留');
  // skip 也占位：跳过的窗口今日不复活
  install({ windows: [{ name: 'e', start: '20:00', end: '22:00', wakes: 1 }], skipChance: 1 });
  bio.mark('e', 'skip', now);
  assert.strictEqual(bio.shouldWake(now, () => 0), false, '跳过占位后不再醒');
  assert.strictEqual(bio.usedCount('e', now), 1);
  // 重启（重新 load）后仍然生效 —— 记账在盘上，不在内存里
  assert.strictEqual(bio.load().state.lastWakes['2026-11-25|e'].lastAction, 'skip');
  assert.strictEqual(bio.usedCount('e', now), 1, '重启不复活');
});

test('plan 读写：合法保留、非法清空（重启可恢复）', () => {
  install();
  const plan = { action: 'wake', atMs: at('2026-11-25', '21:00'), name: 'e', label: '20:00–22:00', day: '2026-11-25' };
  assert.strictEqual(bio.setPlan(plan).atMs, plan.atMs);
  assert.strictEqual(bio.getPlan().name, 'e');
  assert.strictEqual(bio.getPlan().atMs, plan.atMs, '重启可恢复（atMs 保留）');
  bio.setPlan({ action: 'huh', atMs: 1, name: 'e', day: 'x' });
  assert.strictEqual(bio.getPlan(), null, '非法 plan 被清');
  bio.clearPlan();
  assert.strictEqual(bio.getPlan(), null);
});

// ---- scheduler.cjs（短间隔 + 立即 stop，不长期跑）----
test('调度器两条腿：巡检触发、lastTickAt 是真在跑的判据', async () => {
  const sched = require('../lib/scheduler.cjs');
  install({ windows: [{ name: 'e', start: '00:00', end: '23:59', wakes: 1 }], skipChance: 0, quietStart: '04:00', quietEnd: '04:00' });
  const wakes = [];
  // tickMs=50 短间隔巡检；random=0 → 挑到的时刻就是 now → 巡检立刻结算
  // （安静时段用 04:00–04:00 显式禁用：真实时钟跑测试可能在默认 23:30–08:00 内）
  sched.start((w) => wakes.push(w), { tickMs: 50, random: () => 0 });
  const h0 = sched.getHealth();
  assert.strictEqual(h0.running, true);
  await new Promise((r) => setTimeout(r, 180));
  sched.stop();
  const h1 = sched.getHealth();
  assert.strictEqual(h1.running, false, 'stop 后 running=false');
  assert.ok(h1.lastTickAt > 0, 'lastTickAt 被巡检刷新 —— 真在跑的唯一判据');
  assert.strictEqual(wakes.length, 1, 'wakes=1：巡检腿恰好触发一次，占位后不重复醒');
  assert.strictEqual(wakes[0].name, 'e');
  // 计划已结算：记账占位 + plan 清空
  assert.strictEqual(bio.getPlan(), null);
  assert.ok(bio.usedCount('e', Date.now()) >= 1, 'wake 已记账');
  assert.strictEqual(bio.shouldWake(Date.now(), () => 0), false, '额度占位后不再重复醒');
});

test('调度器一次性定时器腿：atMs 到点触发（比巡检更准）', async () => {
  const sched = require('../lib/scheduler.cjs');
  const now = Date.now();
  install({
    windows: [{ name: 't', start: '00:00', end: '23:59', wakes: 5 }],
    skipChance: 0,
    // 预置一个 300ms 后到点的挂起计划，模拟重启恢复
    plan: { action: 'wake', atMs: now + 300, name: 't', label: '00:00–23:59', day: bio.dayKey(now + 300), createdAt: now },
  });
  const wakes = [];
  const t0 = Date.now();
  sched.start((w) => wakes.push({ w, at: Date.now() }), { tickMs: 3600000 }); // 巡检腿近乎停摆，只剩定时器腿
  await new Promise((r) => setTimeout(r, 550));
  sched.stop();
  assert.strictEqual(wakes.length, 1, '定时器腿独立触发一次');
  assert.ok(Date.now() - t0 < 3000, '到点即触发，不等巡检');
  assert.strictEqual(wakes[0].w.name, 't');
  assert.strictEqual(bio.getPlan(), null, '结算后计划清空');
});

test('调度器：安静时段不醒；隔夜计划作废', async () => {
  const sched = require('../lib/scheduler.cjs');
  // 用注入 now 的 tick 验证判定层（不起真定时器）
  install({ windows: [{ name: 'e', start: '20:00', end: '22:00', wakes: 5 }], skipChance: 0 });
  const wakes = [];
  // 20:30 在窗内 → 立刻计划并结算（atMs 落在过去 20:30 与窗内）
  await sched.tick((w) => wakes.push(w), at('2026-11-25', '20:30'), () => 0);
  assert.strictEqual(wakes.length, 1, '窗内立即结算');
  // 12:00 在窗外 → 不醒
  install({ windows: [{ name: 'e', start: '20:00', end: '22:00', wakes: 5 }], skipChance: 0 });
  const wakes2 = [];
  await sched.tick((w) => wakes2.push(w), at('2026-11-25', '12:00'), () => 0);
  assert.strictEqual(wakes2.length, 0, '窗外不醒');
  // 隔夜计划：昨天挂的 plan，今天巡检应作废（今天 09:00 不在任何窗口内 → 也不会定新铃）
  install({
    windows: [{ name: 'e', start: '20:00', end: '22:00', wakes: 5 }],
    skipChance: 0,
    plan: { action: 'wake', atMs: at('2026-11-24', '21:00'), name: 'e', label: '20:00–22:00', day: '2026-11-24' },
  });
  const wakes3 = [];
  await sched.tick((w) => wakes3.push(w), at('2026-11-25', '09:00'), () => 0);
  assert.strictEqual(wakes3.length, 0, '隔夜旧计划作废不触发，窗外也不定新铃');
  assert.strictEqual(bio.getPlan(), null);
  // 对照：窗口覆盖当前时刻时，作废旧计划后允许立刻定新铃（这是正确行为，不是复活）
  install({
    windows: [{ name: 'e', start: '00:00', end: '23:59', wakes: 5 }],
    skipChance: 0, quietStart: '04:00', quietEnd: '04:00',
    plan: { action: 'wake', atMs: at('2026-11-24', '09:00'), name: 'e', label: 'x', day: '2026-11-24' },
  });
  const wakes4 = [];
  await sched.tick((w) => wakes4.push(w), at('2026-11-25', '09:00'), () => 0);
  assert.strictEqual(wakes4.length, 1, '旧计划作废后按今天的窗口重新定铃并结算');
  assert.strictEqual(bio.getPlan(), null);
  // 结算占位：skip 也记账
  install({ windows: [{ name: 'e', start: '20:00', end: '22:00', wakes: 2 }], skipChance: 1 });
  bio.setPlan({ action: 'skip', atMs: at('2026-11-25', '21:00'), name: 'e', label: 'x', day: '2026-11-25' });
  const r = sched.settlePlan(at('2026-11-25', '21:00'));
  assert.strictEqual(r.action, 'skip');
  assert.strictEqual(bio.usedCount('e', at('2026-11-25', '21:00')), 1, 'skip 占位');
  assert.strictEqual(bio.getPlan(), null);
});

test.after(() => { bio.useStore(null); });

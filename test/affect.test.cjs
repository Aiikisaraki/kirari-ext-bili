"use strict";
// 心情与分享欲引擎测试：node --test test/affect.test.cjs
// 纯逻辑测试：状态文件指向临时目录，now 全部注入，不睡计时器。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kirari-affect-'));
process.env.KIRARI_BILI_AFFECT_FILE = path.join(TMP, 'affect.json');

const affect = require('../lib/affect.cjs');
const FILE = process.env.KIRARI_BILI_AFFECT_FILE;
const HOUR = 3600000;

function fresh(now) { return affect.initialState(now); }

test('初始状态：平静、无分享欲、version 1', () => {
  const s = fresh(1000);
  assert.equal(s.version, 1);
  assert.equal(s.mood.emotion, 'content');
  assert.equal(s.mood.intensity, 0);
  assert.equal(s.mood.reason, null);
  assert.equal(s.shareDesire.value, 0);
  assert.deepEqual(s.shareDesire.topics, []);
  // 没素材就不开口
  const d = affect.shouldShare(s, 1000);
  assert.equal(d.should, false);
  assert.match(d.reason, /素材/);
  // 注入块：平静兜底文案
  const block = affect.buildAffectBlock(s, 1000);
  assert.match(block, /【此刻的B站心情】/);
  assert.match(block, /content 0%/);
  assert.match(block, /不要直接念出来/);
});

test('addExperience：interesting>=4 形成话题、推高分享欲与心情', () => {
  const now = 1_000_000;
  const s = fresh(now);
  const r = affect.addExperience(s, [
    { bvid: 'BV1xx411c7mD', topic: '明日方舟剧情', interesting: 5, note: '新PV信息量很大' },
    { bvid: 'BV1xx411c8mD', topic: '猫咪日常', interesting: 4 },
    { bvid: 'BV1xx411c9mD', topic: '做饭翻车', interesting: 2 }, // 不形成话题
  ], now);
  assert.equal(r.applied, 3);
  assert.deepEqual(r.newTopics, ['明日方舟剧情', '猫咪日常']);
  // 分享欲：0.25(新话题5) + 0.15(新话题4) = 0.40
  assert.ok(Math.abs(s.shareDesire.value - 0.40) < 1e-9, 'share=' + s.shareDesire.value);
  // 话题只留 interesting>=4 的
  assert.equal(s.shareDesire.topics.length, 2);
  assert.ok(s.shareDesire.topics[0].weight >= s.shareDesire.topics[1].weight);
  // 心情：平均 11/3≈3.67 → curious，强度 +0.22
  assert.equal(s.mood.emotion, 'curious');
  assert.ok(Math.abs(s.mood.intensity - 0.22) < 1e-9);
  assert.match(s.mood.reason, /挺有收获/);
  // 阈值未到：不许开口
  assert.equal(affect.shouldShare(s, now).should, false);
});

test('addExperience：同话题再次出现会加温并去重 bvid', () => {
  const now = 2_000_000;
  const s = fresh(now);
  affect.addExperience(s, [{ bvid: 'BV1A', topic: 'Live2D', interesting: 5 }], now);
  const r = affect.addExperience(s, [{ bvid: 'BV1B', topic: 'live2d', interesting: 4 }], now + 1000);
  // topic 归一化（大小写）后是同一话题，不产生 newTopics
  assert.deepEqual(r.newTopics, []);
  const t = s.shareDesire.topics.find(x => x.key === 'live2d');
  assert.equal(t.count, 2);
  assert.deepEqual(t.bvids, ['BV1A', 'BV1B']);
  // 5→0.25 新话题，4 加温 +0.15 → 0.40（相隔 1s 有极微衰减，放宽容差）
  assert.ok(Math.abs(s.shareDesire.value - 0.40) < 1e-3, 'share=' + s.shareDesire.value);
});

test('addExperience：interesting 偏低推 bored/tired，不产生话题', () => {
  const now = 3_000_000;
  const s = fresh(now);
  affect.addExperience(s, [{ bvid: 'BV1C', topic: '广告', interesting: 2 }], now);
  assert.equal(s.mood.emotion, 'bored');
  assert.equal(s.shareDesire.topics.length, 0);
  assert.equal(s.shareDesire.value, 0);

  const s2 = fresh(now);
  affect.addExperience(s2, [{ bvid: 'BV1D', topic: '标题党', interesting: 1 }], now);
  assert.equal(s2.mood.emotion, 'tired');
  assert.equal(s2.shareDesire.value, 0);

  // 垃圾输入直接忽略（缺 bvid / 缺 interesting / 非对象）
  const s3 = fresh(now);
  const r = affect.addExperience(s3, [null, '', 'oops', { topic: 'x', interesting: 5 }, { bvid: 'BV1E' }], now);
  assert.equal(r.applied, 0);
  assert.equal(s3.mood.intensity, 0);
  assert.equal(s3.shareDesire.topics.length, 0);

  // interesting 越界收敛到 1..5，不炸
  const s4 = fresh(now);
  affect.addExperience(s4, [{ bvid: 'BV1E', topic: '超纲', interesting: 99 }], now);
  assert.equal(s4.mood.emotion, 'excited');
});

test('衰减：mood 按 8 小时半衰期衰减，分享欲按 24 小时衰减', () => {
  const now = 4_000_000;
  const s = fresh(now);
  affect.addExperience(s, [{ bvid: 'BV1F', topic: '剧情解析', interesting: 5 }], now);
  const mood0 = s.mood.intensity, share0 = s.shareDesire.value;

  // 半衰期后正好剩一半
  const s8 = fresh(now); affect.addExperience(s8, [{ bvid: 'BV1F', topic: '剧情解析', interesting: 5 }], now);
  affect.decayAll(s8, now + 8 * HOUR);
  assert.ok(Math.abs(s8.mood.intensity - mood0 / 2) < 1e-9);

  // 24 小时后分享欲剩一半，心情几乎归零（衰减超过 3 个半衰期 → content 兜底）
  const s24 = fresh(now); affect.addExperience(s24, [{ bvid: 'BV1F', topic: '剧情解析', interesting: 5 }], now);
  affect.decayAll(s24, now + 24 * HOUR);
  assert.ok(Math.abs(s24.shareDesire.value - share0 / 2) < 1e-9);
  assert.equal(s24.mood.emotion, 'content');
  assert.equal(s24.mood.intensity, 0);

  // decaysAt 只做投影，不落盘
  const proj = affect.decaysAt(s, now + 8 * HOUR);
  assert.ok(Math.abs(proj.intensity - mood0 / 2) < 1e-9);
  assert.equal(s.mood.intensity, mood0, '原状态不应被 decaysAt 改动');
  assert.equal(s.mood.at, now);
});

test('阈值判断：分享欲到 0.6 且话题存活才建议开口', () => {
  const now = 5_000_000;
  const s = fresh(now);
  // 分批喂：0.25 + 0.25(不同话题) + 0.15 + 0.05 加温 ≈ 0.70 ≥ 0.6
  affect.addExperience(s, [{ bvid: 'BV1G', topic: '群友语录', interesting: 5 }], now);
  affect.addExperience(s, [{ bvid: 'BV1H', topic: '新番吐槽', interesting: 5 }], now + HOUR);
  assert.ok(s.shareDesire.value < 0.6);
  assert.equal(affect.shouldShare(s, now + HOUR).should, false);
  affect.addExperience(s, [{ bvid: 'BV1I', topic: '虚拟主播切片', interesting: 4 }], now + 2 * HOUR);
  affect.addExperience(s, [{ bvid: 'BV1J', topic: '群友语录', interesting: 5 }], now + 3 * HOUR);
  const v = s.shareDesire.value;
  assert.ok(v >= 0.6, 'share=' + v);
  const d = affect.shouldShare(s, now + 3 * HOUR);
  assert.equal(d.should, true);
  assert.match(d.reason, /群友语录/);
  // 注入块应显示很想聊
  assert.match(affect.buildAffectBlock(s, now + 3 * HOUR), /很想找人聊聊/);
  // 但放 24 小时后：分享欲减半到 0.35，且全部话题过 48h TTL 前一天仍有话题——0.35<0.6 不开口
  const d2 = affect.shouldShare(s, now + 27 * HOUR);
  assert.equal(d2.should, false);
});

test('阈值判断：话题全部过期（TTL 48h）后即使分享欲高也不开口', () => {
  const now = 6_000_000;
  const s = fresh(now);
  // 连续多次同话题把分享欲顶过阈值（0.25 新话题 + 0.15×3 加温，含衰减后 ≈0.67）
  affect.addExperience(s, [{ bvid: 'BV1K', topic: '技术评测', interesting: 5 }], now);
  affect.addExperience(s, [{ bvid: 'BV1L', topic: '技术评测', interesting: 5 }], now + HOUR);
  affect.addExperience(s, [{ bvid: 'BV1M', topic: '技术评测', interesting: 5 }], now + 2 * HOUR);
  affect.addExperience(s, [{ bvid: 'BV1Z', topic: '技术评测', interesting: 5 }], now + 3 * HOUR);
  assert.ok(s.shareDesire.value >= 0.6, 'share=' + s.shareDesire.value);
  assert.equal(affect.shouldShare(s, now + 3 * HOUR).should, true);
  // 52 小时后：最后一次互动在 now+3h，48h TTL 已过，话题全部过期，不许开口
  const d = affect.shouldShare(s, now + 52 * HOUR);
  assert.equal(d.should, false);
  assert.match(d.reason, /素材/);
});

test('坏档自愈：损坏 JSON / 结构错误 / 版本不符都重置为初始状态', () => {
  const now = 7_000_000;
  fs.writeFileSync(FILE, '{ not json at all', 'utf-8');
  let s = affect.load(now);
  assert.equal(s.version, 1);
  assert.equal(s.mood.emotion, 'content');
  assert.equal(s.shareDesire.value, 0);
  assert.equal(s.shareDesire.topics.length, 0);

  fs.writeFileSync(FILE, JSON.stringify({ version: 2, mood: {}, shareDesire: {} }), 'utf-8');
  s = affect.load(now);
  assert.equal(s.version, 1);
  assert.equal(s.shareDesire.topics.length, 0);

  fs.writeFileSync(FILE, JSON.stringify({ version: 1, mood: { emotion: 'haha' }, shareDesire: { value: 'high' } }), 'utf-8');
  s = affect.load(now);
  assert.equal(s.mood.emotion, 'content');

  // 数组也算坏档
  fs.writeFileSync(FILE, '[1,2,3]', 'utf-8');
  s = affect.load(now);
  assert.equal(s.version, 1);

  // 文件不存在不报错
  fs.rmSync(FILE);
  s = affect.load(now);
  assert.equal(s.version, 1);

  // load→save 之后再 load 一次，roundtrip 一致
  affect.addExperience(s, [{ bvid: 'BV1N', topic: '存档往返', interesting: 5 }], now);
  assert.equal(affect.save(s), true);
  const s2 = affect.load(now + 1);
  assert.equal(s2.shareDesire.topics[0].topic, '存档往返');
  assert.ok(Math.abs(s2.shareDesire.value - s.shareDesire.value) < 1e-9);
});

test('recordExperiences 便捷入口：读写文件、坏档自动重置后继续可用', () => {
  const now = 8_000_000;
  fs.writeFileSync(FILE, 'garbage{{{', 'utf-8');
  const { state, result } = affect.recordExperiences(
    [{ bvid: 'BV1O', topic: '手工耿', interesting: 5 }], now);
  assert.equal(result.applied, 1);
  assert.equal(state.mood.emotion, 'excited');
  // 已落盘
  const onDisk = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
  assert.equal(onDisk.shareDesire.topics[0].topic, '手工耿');
  // getAffect 带衰减读回
  const later = affect.getAffect(now + 8 * HOUR);
  assert.ok(later.mood.intensity > 0 && later.mood.intensity < 0.31);
  assert.equal(later.mood.at, now + 8 * HOUR, '衰减后应把 at 推进到当前时刻');
});

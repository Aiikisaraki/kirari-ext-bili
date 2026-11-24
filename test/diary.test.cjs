"use strict";
// 两本日记测试：事件落库 → 派生渲染 → 素材 prompt → 隐私泄漏校验 → 落盘/读取 → 坏档自愈
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

function tmpState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirari-diary-'));
  const stateFile = (name) => path.join(dir, name);
  const diary = require('../lib/diary.cjs');
  diary.configure({ stateFile });
  return { dir, diary, stateFile };
}

const DAY = 86400000;

// ---------- 事件落库 ----------

test('addEvent：落库、字段补全、上限 500', () => {
  const { diary } = tmpState();
  const ev = diary.addEvent({ type: 'browse', bvid: 'BV1xx411c7mD', topic: '测试视频', text: '看到一半停住了', visibility: 'public' });
  assert.ok(ev.id && ev.at > 0, '自动补 id 和 at');
  assert.equal(ev.bvid, 'BV1xx411c7mD');
  assert.equal(ev.visibility, 'public');
  const list = diary.listEvents();
  assert.equal(list.length, 1);
  assert.equal(list[0].text, '看到一半停住了');
  // 坏事件直接拒
  assert.throws(() => diary.addEvent({ type: 'nope', text: 'x', visibility: 'public' }), /type/);
  assert.throws(() => diary.addEvent({ type: 'note', text: 'x', visibility: 'leak' }), /visibility/);
  assert.throws(() => diary.addEvent({ type: 'note', text: '  ', visibility: 'public' }), /text/);
  // 上限 500：留最新的
  for (let i = 0; i < 520; i++) diary.addEvent({ type: 'note', text: 'n' + i, visibility: 'public', at: 1000 + i });
  const all = diary.listEvents();
  assert.equal(all.length, diary.MAX_EVENTS);
  assert.equal(all[all.length - 1].text, 'n519', '保留最新');
  assert.equal(all[0].text, 'n20', '裁掉最旧');
});

test('addEvent：显式 at 入库（时间正序）', () => {
  const { diary } = tmpState();
  diary.addEvent({ type: 'note', text: '早上的', at: 1000, visibility: 'private' });
  diary.addEvent({ type: 'note', text: '晚上的', at: 2000, visibility: 'private' });
  const list = diary.listEvents();
  assert.equal(list[0].text, '早上的');
  assert.equal(list[1].text, '晚上的');
});

// ---------- 派生渲染（事件 → 视图，可重建） ----------

test('renderPublic：只有 public 事件 + 带引用 + 无私人内容', () => {
  const { diary } = tmpState();
  const now = Date.now();
  const events = [
    { id: 'e1', type: 'browse', bvid: 'BV1ab', topic: '猫猫视频', text: '这只猫和楼下那只一模一样', at: now, visibility: 'public' },
    { id: 'e2', type: 'note', text: '其实我今天有点低落', at: now + 1, visibility: 'private' },
    { id: 'e3', type: 'interaction', bvid: 'BV1cd', text: '在评论区看到一句很好的话', at: now + 2, visibility: 'public' },
  ];
  const md = diary.renderPublic(events);
  assert.ok(md.includes('猫猫视频') && md.includes('https://www.bilibili.com/video/BV1ab'), '带可核对引用');
  assert.ok(!md.includes('低落'), '私人事件绝不出现');
  assert.ok(!md.includes('e2'), '私人事件 id 也不出现');
  assert.ok(md.includes('看了') && md.includes('互动了'), '按类型动词');
});

test('renderPublic：空事件给占位；renderPrivate 含私人条目并标注', () => {
  const { diary } = tmpState();
  assert.match(diary.renderPublic([]), /没有可写的公开经历/);
  const now = Date.now();
  const md = diary.renderPrivate([
    { id: 'e1', type: 'note', text: '公开的观察', at: now, visibility: 'public' },
    { id: 'e2', type: 'note', text: '不敢说的话', at: now + 1, visibility: 'private' },
  ]);
  assert.ok(md.includes('公开的观察') && md.includes('不敢说的话'), '私人本是全量');
  assert.match(md, /心里话/, '私人条目有标记');
});

// ---------- 素材 prompt ----------

test('buildDiaryPrompt：public 素材只含公开事件；private 含全部', () => {
  const { diary } = tmpState();
  const now = Date.now();
  const events = [
    { id: 'e1', type: 'browse', bvid: 'BV1ab', topic: '猫猫视频', text: '停住了', at: now, visibility: 'public' },
    { id: 'e2', type: 'note', text: '秘密想法', at: now + 1, visibility: 'private' },
  ];
  const pub = diary.buildDiaryPrompt(events, '2026-11-25');
  assert.equal(pub.visibility, 'public');
  assert.ok(pub.prompt.includes('BV1ab'));
  assert.ok(!pub.prompt.includes('秘密想法'), '私人素材不进公开 prompt');
  assert.ok(/引用|bilibili/.test(pub.prompt), '公开 prompt 要求可核对引用');
  const priv = diary.buildDiaryPrompt(events, '2026-11-25', 'private');
  assert.equal(priv.visibility, 'private');
  assert.ok(priv.prompt.includes('秘密想法') && priv.prompt.includes('BV1ab'), '私人 prompt 全量素材');
  assert.throws(() => diary.buildDiaryPrompt(events, '2026-11-25', 'nope'), /visibility/);
});

// ---------- 隐私泄漏校验 ----------

test('assertNoPrivateLeak：整段拷贝命中即抛', () => {
  const { diary } = tmpState();
  assert.throws(
    () => diary.assertNoPrivateLeak('今天很开心。其实我今天有点低落，但没关系。', [{ text: '其实我今天有点低落' }]),
    /隐私泄漏/,
  );
});

test('assertNoPrivateLeak：片段拷贝（≥10 连续字）也拦', () => {
  const { diary } = tmpState();
  const secret = '我其实一直在担心上次那件事会不会被发现';
  // 10+ 连续字拷贝 → 抛
  assert.throws(
    () => diary.assertNoPrivateLeak('她提到：一直在担心上次那件事会不会被发现，真是的。', [{ text: secret }]),
    /隐私泄漏/,
  );
  // 短于窗口的重合 → 放行（避免误伤常用语）
  assert.doesNotThrow(() => diary.assertNoPrivateLeak('今天有点担心以后的事。', [{ text: secret }]));
});

test('assertNoPrivateLeak：标点/大小写差异不构成绕过', () => {
  const { diary } = tmpState();
  assert.throws(
    () => diary.assertNoPrivateLeak('she said "Wait For Me, OK?" and left.', [{ text: 'wait for me, ok?' }]),
    /隐私泄漏/,
  );
  assert.doesNotThrow(() => diary.assertNoPrivateLeak('完全无关的内容。', [{ text: '秘密' }]));
  return true;
});

// ---------- 落盘 + 读取 ----------

test('commitDiary：两本分别落盘、同日覆盖、show 按 N 天读取', async () => {
  const { diary } = tmpState();
  const today = diary.localDateKey(Date.now());
  const yesterday = diary.localDateKey(Date.now() - DAY);
  diary.commitDiary(today, '今天看了[猫猫视频](https://www.bilibili.com/video/BV1ab)，停住了。', '今天有点想太多。');
  diary.commitDiary(yesterday, '昨天逛到很晚。', '');
  // 同日再提交 → 覆盖不重复
  diary.commitDiary(today, '今天看了[猫猫视频](https://www.bilibili.com/video/BV1ab)，想了很久。', '更新后的心里话。');
  const pub = diary.show('public', 1);
  assert.ok(pub.includes('想了很久'), '今天公开正文');
  assert.ok(!pub.includes('昨天'), 'show(1) 只读今天');
  assert.equal((pub.match(/## /g) || []).length, 1, '同日只有一节');
  const pub2 = diary.show('public', 2);
  assert.ok(pub2.includes('昨天'), 'show(2) 带上昨天');
  const priv = diary.show('private', 7);
  assert.ok(priv.includes('更新后的心里话。') && !priv.includes('今天有点想太多。'), '私人本同日覆盖');
  assert.match(diary.show('private', 1), /心里话|更新后/);
});

test('commitDiary：公开正文命中私人事件原文 → 拒绝落盘', () => {
  const { diary } = tmpState();
  const today = diary.localDateKey(Date.now());
  diary.addEvent({ type: 'note', text: '我其实很怕自己说错话', visibility: 'private' });
  assert.throws(
    () => diary.commitDiary(today, '今天不错。我其实很怕自己说错话，不过算了。', ''),
    /隐私泄漏/,
  );
  // 公开本没写进去
  assert.match(diary.show('public', 1), /没有日记/);
  // 私人本照常可写
  diary.commitDiary(today, '', '私人的话照写。');
  assert.ok(diary.show('private', 1).includes('私人的话照写'));
});

test('commitDiary：参数校验', () => {
  const { diary } = tmpState();
  assert.throws(() => diary.commitDiary('2026/11/25', 'a', ''), /date/);
  assert.throws(() => diary.commitDiary('2026-11-25', '', ''), /为空/);
  assert.throws(() => diary.show('nope', 1), /which/);
});

// ---------- 坏档自愈 ----------

test('坏档自愈：事件档损坏 → 当空档重建，不抛错', () => {
  const { diary, stateFile } = tmpState();
  fs.writeFileSync(stateFile('diary-events.json'), '{not json!!', 'utf-8');
  assert.deepEqual(diary.listEvents(), []);
  diary.addEvent({ type: 'note', text: '重建后第一条', visibility: 'public' });
  assert.equal(diary.listEvents().length, 1);
});

test('坏档自愈：事件档结构错（events 非数组 / 条目缺字段）→ 过滤修复', () => {
  const { diary, stateFile } = tmpState();
  fs.writeFileSync(stateFile('diary-events.json'), JSON.stringify({ events: [
    { id: 'ok1', type: 'note', text: '好的', at: 1, visibility: 'public' },
    { id: 'bad1', type: 'nope', text: '坏类型', at: 2, visibility: 'public' },
    { id: 'bad2', type: 'note', text: '坏可见性', at: 3, visibility: 'friend' },
    { id: 'bad3', type: 'note', at: 4, visibility: 'public' }, // 缺 text
    'not-an-object',
  ] }), 'utf-8');
  const list = diary.listEvents();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'ok1');
});

test('坏档自愈：日记 Markdown 被清空/损坏 → show 不炸，commitDiary 重建', () => {
  const { diary, stateFile } = tmpState();
  const today = diary.localDateKey(Date.now());
  fs.mkdirSync(stateFile('diary'), { recursive: true });
  fs.writeFileSync(path.join(stateFile('diary'), 'whale-diary.md'), '## 2020-01-01\n\n旧内容', 'utf-8');
  assert.match(diary.show('public', 1), /没有日记/, '旧内容不冒充今日');
  diary.commitDiary(today, '今天重新写了一句。', '');
  const md = diary.show('public', 1);
  assert.ok(md.includes('今天重新写了一句。'));
  assert.ok(!md.includes('旧内容'), '同日重建不残留');
});

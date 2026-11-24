"use strict";
// 心情与分享欲（照 dsh-bili-whale 的 affect 系统，适配 B 站桌宠场景）
//
// 铁律（学 whale）：
// ① 心情和分享欲只来自**真实发生过的内容**（看过的视频、收到的反应），不是随机数
// ② 只有「值得分享的内容形成话题」才累积分享欲；没素材就 false，不硬凑
// ③ 纯逻辑、无网络请求；now 一律由调用方注入，可测试
// ④ 惰性衰减：读的时候按半衰期一次性折算，不依赖定时器
const fs = require('fs');
const { stateFile } = require('./paths.cjs');

// ---- 可调参数 ----
const MOOD_HALF_LIFE_MS = 8 * 3600000;      // 心情强度半衰期：8 小时
const SHARE_HALF_LIFE_MS = 24 * 3600000;    // 分享欲半衰期：24 小时（没人聊就慢慢冷下来）
const TOPIC_TTL_MS = 48 * 3600000;          // 话题保鲜期：48 小时，过期不再支撑分享
const SHARE_THRESHOLD = 0.6;                // 分享欲开口阈值
const MOOD_FLOOR = 0.05;                    // 强度低于此值视为心情归零（平静）
const TOPIC_WEIGHT = { 4: 0.15, 5: 0.25 };  // interesting 4/5 的新话题带来的分享欲增量
const TOPIC_WARM_DELTA = 0.15;              // 老话题再次被看到时的加温量
const EMOTIONS = Object.freeze(['excited', 'amused', 'curious', 'content', 'bored', 'tired']);

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const FILE = () => process.env.KIRARI_BILI_AFFECT_FILE || stateFile('affect.json');

// ---- 状态 ----
function initialState(now = Date.now()) {
  return {
    version: 1,
    mood: { emotion: 'content', intensity: 0, reason: null, at: now },
    shareDesire: { value: 0, at: now, topics: [] },
  };
}

// 宽松校验：坏档返回 null（由 load 重置自愈），不抛异常
function validateState(v) {
  if (!v || typeof v !== 'object' || v.version !== 1) return null;
  const m = v.mood, s = v.shareDesire;
  if (!m || !EMOTIONS.includes(m.emotion) || !Number.isFinite(m.intensity) || !Number.isFinite(m.at)) return null;
  if (!s || !Number.isFinite(s.value) || !Number.isFinite(s.at) || !Array.isArray(s.topics)) return null;
  for (const t of s.topics) {
    if (!t || typeof t.key !== 'string' || typeof t.topic !== 'string' || !Number.isFinite(t.weight) || !Number.isFinite(t.lastAt)) return null;
  }
  return {
    version: 1,
    mood: { emotion: m.emotion, intensity: clamp(m.intensity, 0, 1), reason: typeof m.reason === 'string' ? m.reason : null, at: m.at },
    shareDesire: {
      value: clamp(s.value, 0, 1), at: s.at,
      topics: s.topics.map(t => ({ key: t.key, topic: t.topic, bvids: Array.isArray(t.bvids) ? t.bvids.slice(-8) : [], firstAt: Number.isFinite(t.firstAt) ? t.firstAt : t.lastAt, lastAt: t.lastAt, count: Number.isFinite(t.count) ? t.count : 1, weight: clamp(t.weight, 0, 1) })),
    },
  };
}

// ---- 持久化 ----
function load(now = Date.now()) {
  try {
    const fixed = validateState(JSON.parse(fs.readFileSync(FILE(), 'utf-8')));
    if (fixed) return fixed;
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[affect] 状态档损坏，重置自愈:', e.message);
  }
  return initialState(now);
}

function save(state) {
  try {
    fs.writeFileSync(FILE(), JSON.stringify(state, null, 2), { mode: 0o600 });
    return true;
  } catch (e) {
    console.error('[affect] 写入失败:', e.message);
    return false;
  }
}

// ---- 衰减 ----
// 心情强度按 8 小时半衰期折算；低于 MOOD_FLOOR 归零为平静。
function decayMood(mood, now = Date.now()) {
  const dt = Math.max(0, now - mood.at);
  const intensity = mood.intensity * Math.pow(0.5, dt / MOOD_HALF_LIFE_MS);
  if (intensity < MOOD_FLOOR) return { emotion: 'content', intensity: 0, reason: null, at: now };
  return { ...mood, intensity, at: now };
}

// 不落盘的投影：现在此刻的心情长什么样（读时折算，不写回）
function decaysAt(state, now = Date.now()) {
  const m = decayMood(state.mood, now);
  return { emotion: m.emotion, intensity: m.intensity, reason: m.reason };
}

// 存活话题（没过保鲜期的）
function aliveTopics(state, now = Date.now()) {
  return state.shareDesire.topics.filter(t => now - t.lastAt <= TOPIC_TTL_MS);
}

// 每次动状态前先衰减：心情按 8h 半衰期，分享欲按 24h 半衰期，话题按 TTL 淘汰
function decayAll(state, now = Date.now()) {
  state.mood = decayMood(state.mood, now);
  const dt = Math.max(0, now - state.shareDesire.at);
  state.shareDesire.value = clamp(state.shareDesire.value * Math.pow(0.5, dt / SHARE_HALF_LIFE_MS), 0, 1);
  state.shareDesire.at = now;
  state.shareDesire.topics = aliveTopics(state, now)
    .sort((a, b) => b.weight - a.weight || b.lastAt - a.lastAt)
    .slice(0, 8);
  return state;
}

// ---- 经历输入 ----
function sanitizeEvents(events) {
  if (!Array.isArray(events)) return [];
  const out = [];
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    const bvid = typeof e.bvid === 'string' ? e.bvid.trim().slice(0, 32) : '';
    const topic = typeof e.topic === 'string' ? e.topic.trim().slice(0, 60) : '';
    const interesting = Math.round(Number(e.interesting));
    if (!bvid || !Number.isFinite(interesting)) continue;
    out.push({ bvid, topic, interesting: clamp(interesting, 1, 5), note: typeof e.note === 'string' ? e.note.slice(0, 200) : '' });
  }
  return out;
}

const normTopic = (t) => t.toLowerCase().replace(/\s+/g, '');

/**
 * 把这轮浏览的经历写进心情与分享欲。events: [{ bvid, topic, interesting: 1-5, note }]
 * interesting：5 非常有意思 / 4 值得聊 / 3 还行 / 2 一般 / 1 没意思
 * 返回 { applied, moodDelta, shareDelta, newTopics }，state 原地修改。
 */
function addExperience(state, events, now = Date.now()) {
  decayAll(state, now);
  const list = sanitizeEvents(events);
  const before = { mood: state.mood.intensity, share: state.shareDesire.value };
  if (!list.length) return { applied: 0, moodDelta: 0, shareDelta: 0, newTopics: [] };

  // 1) 分享欲：只有 interesting>=4 且带话题的内容才形成/加温话题
  const newTopics = [];
  let shareDelta = 0;
  for (const e of list) {
    if (e.interesting < 4 || !e.topic) continue;
    const key = normTopic(e.topic);
    let t = state.shareDesire.topics.find(x => x.key === key);
    if (t) {
      // 老话题又被看到：加温一点，但收敛
      t.count += 1;
      t.weight = clamp(t.weight + TOPIC_WARM_DELTA, 0, 1);
      if (!t.bvids.includes(e.bvid)) t.bvids = [...t.bvids, e.bvid].slice(-8);
      shareDelta += TOPIC_WARM_DELTA;
      t.lastAt = now;
    } else {
      const w = TOPIC_WEIGHT[e.interesting] ?? 0.15;
      state.shareDesire.topics.push({ key, topic: e.topic, bvids: [e.bvid], firstAt: now, lastAt: now, count: 1, weight: w });
      shareDelta += w;
      newTopics.push(e.topic);
    }
  }
  state.shareDesire.topics.sort((a, b) => b.weight - a.weight);
  state.shareDesire.topics = state.shareDesire.topics.slice(0, 8);
  state.shareDesire.value = clamp(state.shareDesire.value + shareDelta, 0, 1);

  // 2) 心情：按这批经历的平均 interesting 定情绪方向与强度
  const avg = list.reduce((s, e) => s + e.interesting, 0) / list.length;
  const mainTopic = newTopics[0] || list.find(e => e.topic)?.topic || '';
  const about = mainTopic ? '关于「' + mainTopic + '」的' : '';
  let emotion, delta, reason;
  if (avg >= 4.5) {
    emotion = 'excited'; delta = 0.30;
    reason = '刚看了 ' + list.length + ' 个' + (about || '很带感的') + '视频，特别有意思';
  } else if (avg >= 3.5) {
    emotion = 'curious'; delta = 0.22;
    reason = '刚看了几个' + about + '视频，挺有收获';
  } else if (avg >= 2.5) {
    emotion = 'content'; delta = 0.12;
    reason = '随便刷了刷，看到几个还行的视频';
  } else if (avg >= 1.5) {
    emotion = 'bored'; delta = 0.15;
    reason = '刷到的一些内容没什么意思';
  } else {
    emotion = 'tired'; delta = 0.20;
    reason = '刷了半天都是不感兴趣的东西，有点看累了';
  }
  state.mood = { emotion, intensity: clamp(state.mood.intensity + delta, 0, 1), reason, at: now };

  return {
    applied: list.length,
    moodDelta: +(state.mood.intensity - before.mood).toFixed(6),
    shareDelta: +(state.shareDesire.value - before.share).toFixed(6),
    newTopics,
  };
}

// ---- 判断 ----
// 没素材就 false，这是「不硬凑」的核心。素材（存活话题）是硬条件，阈值只是第二道门。
function shouldShare(state, now = Date.now()) {
  const dt = Math.max(0, now - state.shareDesire.at);
  const value = state.shareDesire.value * Math.pow(0.5, dt / SHARE_HALF_LIFE_MS);
  const topics = aliveTopics(state, now);
  if (!topics.length) return { should: false, reason: '还没有值得分享的素材，不硬凑' };
  if (value < SHARE_THRESHOLD) {
    return { should: false, reason: '有点想聊（' + Math.round(value * 100) + '/100），但还没到开口的程度' };
  }
  const top = topics[0];
  return { should: true, reason: '看了 ' + top.count + ' 个关于「' + top.topic + '」的视频，忍不住想聊聊' };
}

// ---- 给模型看的 system 注入块 ----
const MOOD_DESC = {
  excited: '挺兴奋', amused: '觉得很有意思', curious: '挺有收获',
  content: '平静', bored: '有点无聊', tired: '有点累了',
};
function sharePhrase(v) {
  if (v >= SHARE_THRESHOLD) return '很想找人聊聊';
  if (v >= 0.35) return '有点想聊';
  if (v >= 0.15) return '攒了点素材，还不急';
  return '没什么特别想分享的';
}

// 给模型看的 system 注入块。now 为 null 时直接用状态现值（不折算）。
function buildAffectBlock(state, now = null) {
  const m = now == null ? state.mood : decayMood(state.mood, now);
  const dt = now == null ? 0 : Math.max(0, now - state.shareDesire.at);
  const value = now == null ? state.shareDesire.value : state.shareDesire.value * Math.pow(0.5, dt / SHARE_HALF_LIFE_MS);
  const pct = Math.round(m.intensity * 100);
  const parts = [];
  if (m.intensity >= MOOD_FLOOR && m.reason) parts.push('你' + m.reason + '，感觉' + (MOOD_DESC[m.emotion] || m.emotion));
  else parts.push('你现在心态平静');
  parts.push('分享欲：' + sharePhrase(value) + '（' + Math.round(clamp(value, 0, 1) * 100) + '/100）');
  return '【此刻的B站心情】' + parts.join('。') + '。（心情：' + m.emotion + ' ' + pct + '%）。' +
    '这是你的内在状态，不要直接念出来，体现在要不要主动分享上。';
}

// ---- 便捷入口（给命令层用）----
function getAffect(now = Date.now()) {
  const state = load(now);
  decayAll(state, now);
  save(state);
  return state;
}

function recordExperiences(events, now = Date.now()) {
  const state = load(now);
  const result = addExperience(state, events, now);
  save(state);
  return { state, result };
}

module.exports = {
  EMOTIONS, MOOD_HALF_LIFE_MS, SHARE_HALF_LIFE_MS, TOPIC_TTL_MS, SHARE_THRESHOLD,
  initialState, load, save, decayMood, decaysAt, decayAll,
  addExperience, shouldShare, buildAffectBlock, getAffect, recordExperiences,
};

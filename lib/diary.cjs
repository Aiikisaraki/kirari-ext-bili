"use strict";
// 两本日记（照 dsh-bili-whale 的 diary 设计，CommonJS 版）
//
// 数据流（事件 → 视图，可随时重建）：
//   B站经历 --addEvent()--> 事件流 data/diary-events.json（上限 500 条，唯一事实源）
//        --renderPublic()/renderPrivate()--> 派生视图（Markdown，纯函数）
//        --buildDiaryPrompt()--> 素材 prompt（调用方拿去喂模型）
//        --commitDiary()--> data/diary/whale-diary.md + whale-diary-private.md
//
// 隐私铁律：visibility:'private' 的事件绝不能出现在公开日记里。三道闸：
//   ① renderPublic 只消费 public 事件（派生层过滤）；
//   ② buildDiaryPrompt('public') 的素材里只放 public 事件（模型输入层过滤）；
//   ③ commitDiary / assertNoPrivateLeak 对公开正文逐段比对私人事件原文，命中即抛错（落盘层兜底）。
//
// 本模块只负责素材整理，不调模型。

const fs = require('fs');
const path = require('path');
const { stateFile, ensureDir } = require('./paths.cjs');

const MAX_EVENTS = 500;
const TYPES = ['browse', 'interaction', 'note'];
const VISIBILITIES = ['public', 'private'];

// 测试注入点：默认走 lib/paths.cjs 的 data 目录；测试用 configure 指到临时目录
let _stateFile = stateFile;
function configure({ stateFile: sf } = {}) { if (typeof sf === 'function') _stateFile = sf; }
const eventsFile = () => _stateFile('diary-events.json');
const diaryDir = () => ensureDir(_stateFile('diary'));
const publicFile = () => path.join(diaryDir(), 'whale-diary.md');
const privateFile = () => path.join(diaryDir(), 'whale-diary-private.md');

// ---------- 事件流（唯一事实源） ----------

// 本地日期键（照 whale 的教训：别用 UTC 串比本地日期，凌晨 0–8 点会算到昨天）
function localDateKey(at) { return new Date(at).toLocaleDateString('sv-SE'); }

function loadEvents() {
  let v;
  try { v = JSON.parse(fs.readFileSync(eventsFile(), 'utf-8')); } catch { return { events: [] }; }
  // 坏档自愈：结构不对就当空档重新开始，不抛错卡死调用方
  if (!v || typeof v !== 'object' || !Array.isArray(v.events)) return { events: [] };
  v.events = v.events.filter((e) => e && typeof e === 'object' && typeof e.text === 'string'
    && TYPES.includes(e.type) && VISIBILITIES.includes(e.visibility));
  return v;
}

function saveEvents(v) {
  fs.writeFileSync(eventsFile(), JSON.stringify(v, null, 2), { mode: 0o600 });
}

/**
 * 记一条 B站经历。所有日记素材必须先落事件，再派生视图。
 * @param {{type:'browse'|'interaction'|'note', bvid?:string, topic?:string, text:string,
 *          at?:number, visibility:'public'|'private'}} ev
 */
function addEvent({ type, bvid, topic, text, at, visibility }) {
  if (!TYPES.includes(type)) throw new Error('diary: type 必须是 ' + TYPES.join('|'));
  if (!VISIBILITIES.includes(visibility)) throw new Error('diary: visibility 必须是 public|private');
  if (!text || !String(text).trim()) throw new Error('diary: text 不能为空');
  const v = loadEvents();
  const ev = {
    id: 'e' + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36).padStart(3, '0'),
    type,
    bvid: bvid ? String(bvid) : null,
    topic: topic ? String(topic).slice(0, 120) : null,
    text: String(text).slice(0, 600),
    at: Number.isFinite(Number(at)) && Number(at) > 0 ? Number(at) : Date.now(),
    visibility,
  };
  v.events.push(ev);
  if (v.events.length > MAX_EVENTS) v.events = v.events.slice(-MAX_EVENTS);
  saveEvents(v);
  return ev;
}

function listEvents() { return loadEvents().events; }

/** 最近 ms 毫秒之内的事件（时间正序） */
function eventsSince(ms) {
  const since = Date.now() - Math.max(0, Number(ms) || 0);
  return loadEvents().events.filter((e) => e.at >= since);
}

/** 本地日期（YYYY-MM-DD）当天的事件 */
function eventsForDate(date) {
  return loadEvents().events.filter((e) => localDateKey(e.at) === date);
}

// ---------- 派生视图（纯函数，从事件重建） ----------

function hhmm(at) { return String(new Date(at).toISOString()).slice(11, 16); }
function cite(ev) {
  if (!ev.bvid) return '';
  const label = String(ev.topic || ev.bvid).replace(/[\[]]/g, '');
  return '（[' + label + '](https://www.bilibili.com/video/' + ev.bvid + ')）';
}
function groupByDate(events) {
  const days = new Map();
  for (const e of events) {
    const d = localDateKey(e.at);
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(e);
  }
  return days;
}

/**
 * 公开日记视图：只含 public 事件；散文体条目 + 可核对引用；无任何人信息（只写看到的内容与她的反应）。
 */
function renderPublic(events) {
  const pub = (events || []).filter((e) => e.visibility === 'public');
  if (!pub.length) return '（今天没有可写的公开经历）';
  const out = ['# Kirari 的日记', ''];
  for (const [d, list] of groupByDate(pub)) {
    out.push('## ' + d, '');
    for (const e of list) {
      const verb = e.type === 'browse' ? '看了' : e.type === 'interaction' ? '互动了' : '想到';
      out.push('- ' + hhmm(e.at) + ' ' + verb + ' ' + e.text + cite(e));
    }
    out.push('');
  }
  return out.join('\n').trim() + '\n';
}

/**
 * 私人日记视图：她自己的那本，public + private 都在，私人条目标「（心里话）」，口吻不设防。
 */
function renderPrivate(events) {
  const all = (events || []);
  if (!all.length) return '（今天什么都没记）';
  const out = ['# 私人日记（不外传）', ''];
  for (const [d, list] of groupByDate(all)) {
    out.push('## ' + d, '');
    for (const e of list) {
      out.push('- ' + hhmm(e.at) + (e.visibility === 'private' ? ' （心里话）' : '') + ' ' + e.text + cite(e));
    }
    out.push('');
  }
  return out.join('\n').trim() + '\n';
}

// ---------- 素材整理（喂模型的 prompt，由调用方调模型） ----------

function sourceOf(e) {
  return { eventId: e.id, type: e.type, time: hhmm(e.at), text: e.text,
    bvid: e.bvid || undefined, topic: e.topic || undefined };
}

/**
 * 生成一段日记的素材 prompt。visibility 决定喂哪些事件、立哪些规矩：
 *   buildDiaryPrompt(events, date)             → 公开那本（默认）
 *   buildDiaryPrompt(events, date, 'private')  → 私人那本
 * 返回 { prompt, visibility }；调用方把 prompt 喂给模型，把生成的正文交给 commitDiary。
 */
function buildDiaryPrompt(events, date, visibility = 'public') {
  if (!VISIBILITIES.includes(visibility)) throw new Error('diary: visibility 必须是 public|private');
  const pub = visibility === 'public';
  // 第二道闸：公开 prompt 的素材里只放 public 事件，私人素材根本不进模型输入
  const scope = pub ? (events || []).filter((e) => e.visibility === 'public') : (events || []);
  const rules = pub
    ? [
      '【这是哪本】给主人看的那本：只写公开素材里真实发生的事——看了哪条、哪句让她停住、想对主人说什么。',
      '【引用】提到视频时必须给可核对引用，格式：[视频标题](https://www.bilibili.com/video/BV号)。',
      '【隐私】不得出现任何私人素材，不得出现任何人的 ID、昵称、签名等个人信息。',
    ]
    : [
      '【这是哪本】她自己的那本：不加滤镜，可以写犹豫、怕、没说出口的话、今天觉得做对或做错的。',
      '【口吻】更随意，像她在自言自语；不用给引用。',
    ];
  const prompt = [
    '【任务】为 Kirari 写 ' + date + ' 这一天的日记正文。',
    ...rules,
    '【写法】1–3 段散文体，150–500 字；具体到细节（哪条视频、哪句话、她的反应）；不分点、不加小标题、不写日期行；不要评论式收尾。',
    '【底线】只写素材里有的事，不编造；素材里标了「仅工具取得文字」就别说看过画面；素材确实没东西可写就只输出：SKIP',
    '【素材】',
    JSON.stringify(scope.map(sourceOf)),
  ].join('\n');
  return { prompt, visibility };
}

// ---------- 隐私校验 ----------

function normalize(s) {
  return String(s).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * 铁律校验：公开正文里命中任何私人事件原文（含片段拷贝）即 throw。
 * @param {string} publicText 模型生成的公开日记正文
 * @param {Array<{text:string}|string>} privateEvents 私人事件（或私人文本）列表
 */
function assertNoPrivateLeak(publicText, privateEvents) {
  const pub = normalize(publicText);
  for (const item of privateEvents || []) {
    const raw = typeof item === 'string' ? item : (item && item.text) || '';
    const priv = normalize(raw);
    if (!priv) continue;
    if (pub.includes(priv)) {
      throw new Error('diary: 隐私泄漏——公开日记里出现了私人事件原文「' + raw.slice(0, 40) + '…」');
    }
    // 片段拷贝也拦：私人文本里任意连续 10 个字出现在公开正文就算泄漏
    const WIN = 10;
    if (priv.length > WIN) {
      for (let i = 0; i + WIN <= priv.length; i++) {
        const frag = priv.slice(i, i + WIN);
        if (pub.includes(frag)) {
          throw new Error('diary: 隐私泄漏——公开日记里出现了私人素材片段「' + frag + '…」');
        }
      }
    }
  }
  return true;
}

// ---------- 落盘（模型生成好的正文，按日期分节） ----------

function parseSections(text) {
  const out = [];
  let cur = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^##\s*(\d{4}-\d{2}-\d{2})\s*$/);
    if (m) { cur = { date: m[1], body: [] }; out.push(cur); continue; }
    if (cur) cur.body.push(line);
  }
  for (const s of out) s.body = s.body.join('\n').trim();
  return out.filter((s) => s.body);
}

function serializeSections(list) {
  return list.map((s) => '## ' + s.date + '\n\n' + s.body + '\n').join('\n');
}

function upsertSection(file, date, body) {
  const list = parseSections((() => { try { return fs.readFileSync(file, 'utf-8'); } catch { return ''; } })());
  const hit = list.find((s) => s.date === date);
  if (hit) hit.body = String(body).trim();
  else list.push({ date, body: String(body).trim() });
  list.sort((a, b) => (a.date < b.date ? 1 : -1)); // 新的在上
  fs.writeFileSync(file, serializeSections(list), { mode: 0o600 });
}

/**
 * 把模型生成好的两段正文落盘。公开正文先过隐私校验（当天私人事件 + 全部近期私人事件）。
 * @param {string} date 'YYYY-MM-DD'（本地日期）
 * @param {string} publicText  可为空串（跳过公开本）
 * @param {string} privateText 可为空串（跳过私人本）
 */
function commitDiary(date, publicText, privateText) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error('diary: date 必须是 YYYY-MM-DD');
  const pub = String(publicText || '').trim();
  const priv = String(privateText || '').trim();
  if (!pub && !priv) throw new Error('diary: 两段正文都为空，不落盘');
  // 第三道闸：落盘前对公开正文做泄漏校验（当天的 + 事件流里全部私人事件）
  if (pub) assertNoPrivateLeak(pub, loadEvents().events.filter((e) => e.visibility === 'private'));
  if (pub) upsertSection(publicFile(), date, pub);
  if (priv) upsertSection(privateFile(), date, priv);
  return { date, committed: { public: !!pub, private: !!priv } };
}

// ---------- 读 ----------

/**
 * 读最近 N 天的日记正文。
 * @param {'public'|'private'} which 默认 'public'
 * @param {number} days 默认 1
 * @returns {string} Markdown；这段时间没有就给一句占位（不拿旧内容冒充）
 */
function show(which = 'public', days = 1) {
  if (!VISIBILITIES.includes(which)) throw new Error('diary: which 必须是 public|private');
  const n = Math.max(1, Math.floor(Number(days) || 1));
  const file = which === 'public' ? publicFile() : privateFile();
  let text = '';
  try { text = fs.readFileSync(file, 'utf-8'); } catch { return '（这段时间没有日记）'; }
  const since = localDateKey(Date.now() - (n - 1) * 86400000);
  const hits = parseSections(text).filter((s) => s.date >= since);
  if (!hits.length) return '（这段时间没有日记）';
  return serializeSections(hits).trim() + '\n';
}

module.exports = {
  configure,
  addEvent, listEvents, eventsSince, eventsForDate,
  renderPublic, renderPrivate,
  buildDiaryPrompt,
  assertNoPrivateLeak,
  commitDiary, show,
  localDateKey,
  MAX_EVENTS,
  // 测试与重建用
  _internals: { normalize, parseSections, serializeSections, loadEvents },
};

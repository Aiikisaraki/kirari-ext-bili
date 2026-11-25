"use strict";
// ── B 站见闻隐私闸门（按用户 2026-11-24 拍板的原则）──────────────
//
// 记忆分两类：
//   A. 真实社交圈的人（主人/家人/朋友/任何现实中认识的人）—— 绝对不进 B 站记忆。
//      B 站扩展根本不接触社交圈数据；即便视频标题/评论里出现这类名字，也拦截。
//   B. B 站内容里的角色/创作者/话题 —— 可以泛化记录（如「一个讲 AI 的视频」），
//      但不写具体账号 ID、联系方式、粉丝数等可定位真实个人的信息。
//
// 互动原则：评论只能聊相关话题；私信永久禁止（扩展里不提供私信工具）。

// A 类硬禁止：一旦出现就整条拒绝
const REJECT_PATTERNS = [
  /@[\u4e00-\u9fa5A-Za-z0-9_]{2,30}/g,                  // @提及（可能是熟人）
  /1[3-9]\d{9}/g,                                        // 手机号
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,     // 邮箱
  /(?:微信|VX|v信|QQ群|扣扣|微信号)/gi,                   // 社交联系方式
  /(?:粉丝|关注者|私信|转账|红包)/g,                      // 社交/账户关系
  /(?:小|老|阿)[\u4e00-\u9fa5]{1,2}(?=[，。、！？\s]|今天|说|讲|发|的)/g, // 小X/老X/阿X 类昵称
  /[\u4e00-\u9fa5]{2,3}(?:酱|君|桑|同学|大大)/g,           // 昵称后缀
  /[「『"']([^」』"']{0,40}(?:我叫|我是|我家|我们学校|我公司|我朋友|我老公|我老婆|我儿子|我女儿)[^」』"']{0,80})[」』"']/g, // 评论里的真人自述
];

// 社交圈姓名黑名单（由宿主注入；这里留接口，默认空）。
// 宿主调用 scrubObservation 时传入 knownPersons（主人/家人/朋友的昵称与账号），
// 命中其中任一个 → 整条拒绝。
let KNOWN_PERSONS = [];
function setKnownPersons(names = []) {
  KNOWN_PERSONS = (Array.isArray(names) ? names : []).map((s) => String(s).trim()).filter((s) => s.length >= 2);
}

function hitKnownPerson(s) {
  for (const name of KNOWN_PERSONS) {
    if (s.includes(name)) return true;
  }
  return false;
}

function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').replace(/^[，。、\s]+|[，。、\s]+$/g, '').trim();
}

/**
 * 清洗一条 B 站见闻。B 类内容允许泛化保留，A 类真实社交圈信息一律拒绝。
 * @param {object} obs - { topic, title, bvid, category, myTakeaway, mood, knownPersons }
 * @returns {{ok:boolean, text?:string, reason?:string, kind?:string}}
 */
function scrubObservation(obs = {}) {
  if (!obs || typeof obs !== 'object') return { ok: false, reason: 'invalid' };
  if (obs.knownPersons) setKnownPersons(obs.knownPersons);

  // 白名单字段；bvid 只作溯源不进记忆文本
  const topic = clean(String(obs.topic || '').slice(0, 60));
  // 标题：与 topic 分开。topic 是「话题方向」，title 是「这条叫什么名字」。
  // 有 title 时优先用它——她得先能说出「看的是什么」，才谈得上记得住。
  const title = clean(String(obs.title || '').slice(0, 100));
  const takeaway = clean(String(obs.myTakeaway || '').slice(0, 120));
  const mood = clean(String(obs.mood || '').slice(0, 20));
  const category = clean(String(obs.category || '').slice(0, 20));
  // 有标题也算「有东西可记」——只要不是完全空的一条。
  if (!topic && !title && !takeaway) return { ok: false, reason: 'empty' };

  // A 类拦截 + 禁止模式
  const all = [topic, title, takeaway, mood, category].join(' ');
  if (hitKnownPerson(all)) return { ok: false, reason: 'known_person_detected' };
  for (const re of REJECT_PATTERNS) { re.lastIndex = 0; if (re.test(all)) return { ok: false, reason: 'personal_info_detected' }; }

  // B 类泛化：视频标题里的角色/创作者名允许作为「内容话题」保留，
  // 但不写账号 ID、联系方式。输出仍以她自己的视角为主。
  const take = String(takeaway || '').replace(/^(我|自己|本鱼|她)[:：]?\s*/, '').trim();
  const parts = [];
  if (title) {
    // 有标题：说清「看的是什么」。分区名放括号里补充语境，不喧宾夺主。
    parts.push('刷到《' + title.replace(/[《》]/g, '') + '》' + (category ? '（' + category + '）' : ''));
  } else if (topic) {
    parts.push('刷到一个讲' + topic + '的内容');
  } else {
    parts.push('刷到点东西');
  }
  if (take) parts.push('我觉得' + take);
  if (mood) parts.push('心情是' + mood);
  let text = parts.join('，') + '。';

  // 输出前二次校验
  if (hitKnownPerson(text)) return { ok: false, reason: 'known_person_detected_final' };
  for (const re of REJECT_PATTERNS) { re.lastIndex = 0; if (re.test(text)) return { ok: false, reason: 'personal_info_detected_final' }; }
  if (text.length > 240) text = text.slice(0, 240);
  return { ok: true, text, kind: 'bili-observed' };
}

/**
 * 宿主二次校验接口。
 *
 * @param {string} text 待校验文本
 * @param {string[]} [knownPersons] 社交圈名单
 * @param {boolean} [publicContent] 这段文本是否来自**公开作品**（视频标题/简介/见闻）
 *
 * ── 为什么要分模式（2026-11-25）──────────────────────────────────
 * 默认模式的 REJECT_PATTERNS 会连带拦掉公开内容的正常成分：
 *   「长达数小时！」→ 命中「小X」昵称规则（小 + 时 + ！）
 *   「@某某 的合作」→ 命中 @提及 规则
 * 于是 B 站见闻被大量判死，记忆只剩「刷到点东西」，她自然什么都答不上来。
 * 公开模式只拦两件真危险的事：用户社交圈姓名、硬标识符。
 */
function isSafeBiliMemory(text, knownPersons, publicContent) {
  if (knownPersons) setKnownPersons(knownPersons);
  const s = String(text || '');
  if (hitKnownPerson(s)) return false;
  if (publicContent === true) return scrubPublicTitle(s, null).ok;
  for (const re of REJECT_PATTERNS) { re.lastIndex = 0; if (re.test(s)) return false; }
  return true;
}

/**
 * 公开作品标题 / 简介的专用闸门。**比 isSafeBiliMemory 宽松得多，而且必须宽松。**
 *
 * ── 为什么不能复用 REJECT_PATTERNS（2026-11-25）────────────────────
 * 第一版直接把 scrubObservation 拿来过滤标题，结果大量正常标题被判掉：
 *   「长达数小时！」命中「小X」昵称规则（小 + 时 + 标点）
 *   「@某某 的合作」命中 @提及 规则
 * 于是记忆里只剩下「刷到点东西」这种空壳，她照样什么都说不出来。
 *
 * 两类信息的风险根本不同：
 *   · 私聊/评论里的 @提及、小X 昵称 → 可能是**用户的熟人**，必须挡
 *   · 公开视频的标题 → 那是**创作者公开发布的**，提名字是内容本身，不是泄露
 *
 * 所以这里只挡两类真正危险的东西：
 *   ① 用户的社交圈姓名（KNOWN_PERSONS 注入，这才是唯一真正的隐私风险）
 *   ② 硬标识符：手机号 / 邮箱 / 微信号 / QQ 群号
 * 角色名、UP主名、作品名一律放行 —— 它们是「她看过什么」的实质内容。
 *
 * @param {string} text 标题或简介
 * @param {string[]} [knownPersons] 社交圈名单（覆盖全局设置）
 * @returns {{ok:boolean, text?:string, reason?:string}}
 */
function scrubPublicTitle(text, knownPersons) {
  const s = clean(String(text || ''));
  if (!s) return { ok: false, reason: 'empty' };
  if (knownPersons) setKnownPersons(knownPersons);
  // ① 社交圈姓名：唯一需要拦的内容级风险
  if (hitKnownPerson(s)) return { ok: false, reason: 'known_person_detected' };
  // ② 硬标识符（这几条无论如何都不该进记忆）
  const HARD = [
    /1[3-9]\d{9}/,                                            // 手机号
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,          // 邮箱
    /(?:微信|VX|v信|QQ群|扣扣|微信号)[:：]?\s*[A-Za-z0-9_-]{4,}/i, // 微信号/QQ群号
  ];
  for (const re of HARD) { if (re.test(s)) return { ok: false, reason: "personal_info_detected" }; }
  return { ok: true, text: s.slice(0, 120) };
}
/** 评论话题相关性检查（P2 用）：评论必须围绕视频主题，禁止私信 */
function isRelevantComment(comment, topic) {
  const c = clean(String(comment || ''));
  const t = clean(String(topic || ''));
  if (!c || c.length > 200) return false;
  if (/私信|加我|加V|微信|QQ|联系我/.test(c)) return false; // 禁止引流/私信
  if (!t) return c.length >= 4;
  // 粗粒度相关性：主题词有交集，或评论明显在讨论内容
  const tokens = t.replace(/[\W_]/g, ' ').split(/\s+/).filter((x) => x.length >= 2);
  return tokens.some((x) => c.includes(x)) || /视频|这个|这段|讲的|说的是|有意思|看到/.test(c);
}

module.exports = { scrubObservation, isSafeBiliMemory, isRelevantComment, scrubPublicTitle, setKnownPersons, REJECT_PATTERNS };

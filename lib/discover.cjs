"use strict";
// discover / explore：自主发现与关键词探索（0.3.0 重构时丢失，2026-11-25 补回）
//
// ── 为什么必须补回来 ─────────────────────────────────────────────
// 0.2.0 → 0.3.0 那次「按 whale 结构重构」把 methods 里的 discover / explore
// 整段删掉了（server.cjs 的 42 个方法里既没有 discover 也没有 explore），
// 但宿主侧两处还在调：
//   · src/services/biliBiolock.js  → svc.discover({ count: 3 })   生物钟醒来
//   · src/capabilities/builtin/bili_explore.js → svc.discover / svc.explore
// 结果是每次醒来都返回「未知方法：discover」，**一条内容都没读到**，
// 自然也就没有任何东西可以写进记忆。用户看到的就是「啥都不记得」。
//
// ── 与旧实现（重构前那次提交）的差别 ─────────────────────────────
// 旧版只把「分区名」当主题进记忆，标题一律丢掉（隐私考虑：标题里可能有真名）。
// 代价是她确实不知道自己看过什么，答不上「影视杂谈是什么」这种问题。
// 现在改成**逐条过闸门**：标题安全就保留，不安全就退回分区名 ——
// 既不是全丢（记不住），也不是全留（泄露）。
//
// 纯逻辑：api 由调用方注入，零全局状态。

const { scrubPublicTitle, setKnownPersons } = require('./scrub.cjs');

/** 分区 ID → 名字的兜底映射（接口没给 tname 时用） */
const RID_NAMES = { 1: '动画', 4: '游戏', 36: '知识', 160: '生活', 188: '科技', 119: '鬼畜', 155: '时尚', 181: '影视' };

/**
 * 标题闸门。**不能用 scrubObservation** —— 那套正则给「私聊里提到别人」设计，
 * 里面的「小X/老X/阿X 昵称」「@提及」规则会把公开作品名大批误杀：
 * 「长达数小时！」命中「小X」，「@某某 的合作」命中 @提及。
 * 公开标题是创作者自己发布的，提名字属于内容本身。详见 lib/scrub.cjs。
 *
 * @param {string} title
 * @param {string[]} [knownPersons]
 * @returns {string|null} 通过的标题；被拦或空则 null
 */
function scrubTitle(title, knownPersons) {
  const t = String(title || '').replace(/<[^>]+>/g, '').trim();
  if (!t) return null;
  const chk = scrubPublicTitle(t, knownPersons);
  return chk.ok ? chk.text : null;
}

/** 把接口返回的一条视频规整成内部形状；bvid 不合法直接丢。 */
function normVideo(v, source) {
  const bvid = String(v.bvid || '');
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return null;
  return {
    bvid,
    title: String(v.title || '').replace(/<[^>]+>/g, '').trim(),
    category: String(v.tname || v.category || '').trim(),
    play: Number(v.play || (v.stat && v.stat.view) || 0),
    duration: Number(v.duration || 0),
    pubdate: Number(v.pubdate || 0),
    source: source || 'popular',
  };
}

/**
 * 自主发现：优先用她登录账号的推荐流，退到公开热门与分区排行。
 *
 * @param {object} api BiliApi 实例
 * @param {object} [opts]
 * @param {number} [opts.count=3] 最终挑几条
 * @param {string[]} [opts.seenBvids] 看过的不再推
 * @param {string[]} [opts.keywords] 泛兴趣关键词（最多用两组）
 * @param {string[]} [opts.knownPersons] 闸门用的社交圈名单
 * @param {boolean} [opts.withDesc=true] 是否补取简介（拿「讲的是什么」）
 */
async function discover(api, opts) {
  const o = opts || {};
  const count = Math.min(6, Math.max(1, Number(o.count) || 3));
  const withDesc = o.withDesc !== false;
  const seen = new Set((o.seenBvids || []).map(String));
  const known = o.knownPersons || [];
  if (known.length) setKnownPersons(known);

  const candidates = new Map();
  const gather = async (fn, label) => {
    try {
      const list = (await fn()) || [];
      for (const raw of list) {
        const v = normVideo(raw, label);
        if (!v || seen.has(v.bvid) || candidates.has(v.bvid)) continue;
        candidates.set(v.bvid, v);
      }
    } catch (e) {
      // 单个来源失败不致命：换下一个，最多候选少一点
      console.error('[discover] 来源 ' + label + ' 失败: ' + (e && e.message));
    }
  };

  // ① 她登录账号的推荐流（最贴口味）
  let personalized = false;
  if (api.loginStatus && api.loginStatus().loggedIn) {
    await gather(() => api.request('/x/web-interface/index/top/feed/rcmd', {
      ftype: 0, freshtype: 0, ps: 20, flavor: 0, platform: 'pc',
    }).then((r) => (r.code === 0 ? ((r.data && r.data.item) || []) : [])), 'feed');
    personalized = candidates.size > 0;
  }

  // ② 公开热门
  await gather(() => api.request('/x/web-interface/popular', { ps: 20, pn: 1 })
    .then((r) => (r.code === 0 ? ((r.data && r.data.list) || []) : [])), 'popular');

  // ③ 分区排行：科技/游戏/生活/知识/动画各一页（口味分散，别老刷同一类）
  for (const rid of [188, 4, 160, 36, 1]) {
    await gather(() => api.request('/x/web-interface/ranking/v2', { rid: rid, type: 'all' })
      .then((r) => (r.code === 0 ? ((r.data && r.data.list) || []) : [])), 'region:' + (RID_NAMES[rid] || rid));
  }

  // ④ 泛兴趣关键词（可选，最多两组，避免把读额度用光）
  for (const kw of (o.keywords || []).slice(0, 2)) {
    await gather(() => api.request('/x/web-interface/search/type', { search_type: 'video', keyword: String(kw), page: 1 })
      .then((r) => (r.code === 0 ? ((r.data && r.data.result) || []) : [])), 'search:' + kw);
  }

  // 有趣度：播放量（对数）+ 有分区 + 标题信息量。不用标题内容判断，只做排序。
  const scored = [...candidates.values()]
    .map((v) => Object.assign({}, v, {
      score: Math.round((Math.log10(Math.max(1, v.play)) * 2 + (v.category ? 1 : 0) + v.title.length / 40) * 10) / 10,
    }))
    .sort((a, b) => b.score - a.score);

  const picked = scored.slice(0, count);

  // 补简介：没有简介只能记标题，有了简介才能记「讲的是什么」。
  // 这一步是「看懂了什么」与「只知道名字」的分界线。失败不阻塞。
  if (withDesc) {
    for (const v of picked) {
      try {
        const info = await api.request('/x/web-interface/view', { bvid: v.bvid });
        if (info.code === 0 && info.data) {
          v.desc = String(info.data.desc || '').trim().slice(0, 200);
          v.duration = Number(info.data.duration || v.duration || 0);
          const owner = String((info.data.owner && info.data.owner.name) || '');
          // 作者名同样过闸门：像「小美酱」这种昵称不要落进记忆
          v.ownerSafe = (/^[\u4e00-\u9fa5A-Za-z0-9_-]{1,20}$/.test(owner) && !/酱|君|桑|同学|大大/.test(owner)) ? owner : '';
        }
      } catch (e) {
        console.error('[discover] 取简介失败 ' + v.bvid + ': ' + (e && e.message));
      }
    }
  }

  // 观察：正文自己拼，不走 scrubObservation（那套激进正则会把正常内容判死）。
  const observations = [];
  for (const v of picked) {
    const safeTitle = scrubTitle(v.title, known);
    const safeDesc = scrubTitle(v.desc, known);
    if (!safeTitle && !v.category) continue;
    const head = safeTitle
      ? '刷到《' + safeTitle.replace(/[《》]/g, '') + '》' + (v.category ? '（' + v.category + '）' : '')
      : '刷到一个讲' + (v.category || '视频') + '的内容';
    const extra = [];
    if (safeDesc && safeDesc !== safeTitle) extra.push('简介里说：' + safeDesc.slice(0, 120));
    if (v.ownerSafe) extra.push('作者是' + v.ownerSafe);
    observations.push({
      text: head + (extra.length ? ' ' + extra.join('；') : ''),
      bvid: v.bvid,
      title: safeTitle,
      category: v.category,
      desc: safeDesc || '',
      owner: v.ownerSafe || '',
      duration: v.duration || 0,
      url: 'https://www.bilibili.com/video/' + v.bvid,
      safe: !!safeTitle,
    });
  }

  return {
    personalized: personalized,
    totalCandidates: candidates.size,
    videos: picked.map((v) => ({
      bvid: v.bvid,
      title: scrubTitle(v.title, known) || (v.category ? '（' + v.category + '）' : '（标题已隐去）'),
      category: v.category,
      url: 'https://www.bilibili.com/video/' + v.bvid,
      score: v.score,
    })),
    observations: observations,
  };
}

/**
 * 关键词探索：搜索 → 兜底热门。搜不到就降级，保证「自己出去看看」永远有结果。
 *
 * @param {object} api
 * @param {object} [opts] { keyword, takeaway, knownPersons }
 */
async function explore(api, opts) {
  const o = opts || {};
  const keyword = String(o.keyword || '').trim().slice(0, 60);
  if (!keyword) throw new Error('explore 需要 keyword');
  const known = o.knownPersons || [];
  if (known.length) setKnownPersons(known);

  let videos = [];
  let source = 'search';
  try {
    const r = await api.request('/x/web-interface/search/type', { search_type: 'video', keyword: keyword, page: 1 });
    if (r.code === 0) videos = ((r.data && r.data.result) || []).map((v) => normVideo(v, 'search')).filter(Boolean);
  } catch (e) {
    console.error('[explore] 搜索失败，降级热门: ' + (e && e.message));
  }
  if (!videos.length) {
    source = 'popular-fallback';
    const r = await api.request('/x/web-interface/popular', { ps: 10, pn: 1 });
    if (r.code === 0) videos = ((r.data && r.data.list) || []).map((v) => normVideo(v, 'popular')).filter(Boolean);
  }

  const observations = [];
  for (const v of videos.slice(0, 3)) {
    const safeTitle = scrubTitle(v.title, known);
    if (!safeTitle && !v.category) continue;
    const head = safeTitle
      ? '刷到《' + safeTitle.replace(/[《》]/g, '') + '》' + (v.category ? '（' + v.category + '）' : '')
      : '刷到一个讲' + (v.category || keyword) + '的内容';
    if (o.takeaway) head += ' 我觉得' + String(o.takeaway).slice(0, 120);
    observations.push({
      text: head,
      bvid: v.bvid,
      title: safeTitle,
      category: v.category,
      url: 'https://www.bilibili.com/video/' + v.bvid,
      safe: !!safeTitle,
    });
  }

  return {
    source: source,
    keyword: keyword,
    videos: videos.slice(0, 3).map((v) => ({
      bvid: v.bvid,
      title: scrubTitle(v.title, known) || (v.category ? '（' + v.category + '）' : '（标题已隐去）'),
      category: v.category,
      url: 'https://www.bilibili.com/video/' + v.bvid,
    })),
    observations: observations,
  };
}

module.exports = { discover, explore, scrubTitle, RID_NAMES };

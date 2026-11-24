"use strict";
// browse：一轮自主浏览（照 dsh-bili-whale 的 round 流程）
//
// 关键设计：
//   1. 跳过权：没素材/不值得就跳过，跳过也记录理由 —— 不为了产出硬凑
//   2. 有来源：每个发现带 bvid + 标题 + 她读到的片段，可审计
//   3. 有界上下文：只把摘要给模型，不塞整本日记
const history = require('./history.cjs');

/**
 * 跑一轮浏览：选片 → 粗看 → 挑几条深读 → 返回素材（由模型判断值不值得说）
 * @param api BiliApi
 * @param debriefFn debrief 函数
 * @param args { maxVideos=5, deepCount=2, keywords=[], avoidWords=[] }
 */
async function round(api, debriefFn, args = {}) {
  const maxVideos = Math.min(8, Math.max(1, Number(args.maxVideos) || 5));
  const deepCount = Math.min(4, Math.max(1, Number(args.deepCount) || 2));
  const seen = new Set(history.seenBvids());

  // 1) 选片：热门 + 搜索（按口味），排除看过的
  const candidates = [];
  const push = (list, src) => {
    for (const v of (list || [])) {
      const bvid = String(v.bvid || '');
      if (!bvid || seen.has(bvid)) continue;
      if (candidates.some(c => c.bvid === bvid)) continue;
      const title = String(v.title || '');
      if ((args.avoidWords || []).some(w => w && title.includes(w))) continue;
      candidates.push({ bvid, title, category: String(v.category || v.tname || ''), play: Number(v.play||0), source: src });
    }
  };
  const hot = await api.request('/x/web-interface/popular', { ps: 20, pn: 1 });
  if (hot.code === 0) push(hot.data.list, 'popular');
  for (const kw of (args.keywords || []).slice(0, 3)) {
    const s = await api.request('/x/web-interface/search/type', { search_type: 'video', keyword: kw, page: 1 });
    if (s.code === 0) push(s.data.result, 'search:' + kw);
  }

  if (!candidates.length) {
    return { ok: true, skipped: true, reason: '没有候选（可能都被看过了，或搜索失败）', videos: [], note: '这一轮没有素材就不说话，跳过很正常' };
  }

  // 2) 取前 N 条粗看，再挑 deepCount 条深读
  const picked = candidates.slice(0, maxVideos);
  const deep = picked.slice(0, deepCount);
  const details = [];
  for (const v of deep) {
    try {
      const d = await debriefFn(api, { bvid: v.bvid, noFrames: true });
      if (d.ok) details.push({ ...v, hasContent: d.hasContent, transcript: d.transcript, desc: d.meta.desc, comments: d.comments.slice(0,5), hotspots: d.hotspots.slice(0,3) });
      else details.push({ ...v, error: d.error });
    } catch (e) { details.push({ ...v, error: e.message }); }
  }

  // 3) 记录已看（下次不再推）
  history.markSeen(picked.map(v => v.bvid));

  // 4) 判断有没有可说的素材
  const usable = details.filter(d => d.hasContent && d.transcript && d.transcript.length > 100);
  if (!usable.length) {
    return { ok: true, skipped: true, reason: '候选都读不到实质内容（无字幕/无简介）', videos: picked, details, note: '没读到内容就不说看过，跳过这一轮' };
  }

  return { ok: true, skipped: false, videos: picked, details: usable, note: '素材已备齐，由模型判断值不值得分享' };
}

module.exports = { round };

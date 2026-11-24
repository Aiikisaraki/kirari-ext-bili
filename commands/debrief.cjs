"use strict";
// debrief：六路看懂一条视频（照 dsh-bili-whale 的设计）
// 封面/标题/简介 → 它自称是什么；官方字幕 → 到底说了什么；
// 弹幕热区 → 观众在哪炸了；热评 → 看完的人怎么看；画面抽帧 → 长什么样。
//
// 本模块只负责**把素材备齐并对齐**，最后读图+合成结论必须模型做。
const { execFileSync } = require('child_process');

function fmtTime(sec) { const s = Math.max(0, Math.floor(sec)); return String(Math.floor(s/60)).padStart(2,'0') + ':' + String(s%60).padStart(2,'0'); }

/** 取字幕文本（多分P 采样） */
async function getSubtitles(api, bvid) {
  const info = await api.request('/x/web-interface/view', { bvid });
  if (info.code !== 0) return { ok: false, error: info.message };
  const { aid, cid, pages } = info.data;
  const player = await api.request('/x/player/v2', { aid, cid });
  if (player.code !== 0) return { ok: false, error: player.message };
  const subs = (player.data.subtitle || {}).subtitles || [];
  if (!subs.length) return { ok: true, subtitles: [], note: '这条视频没有官方字幕' };
  const out = [];
  for (const s of subs.slice(0, 3)) {
    try {
      const raw = String(s.subtitle_url || '').trim();
      if (!raw) continue; // 空地址跳过
      const u = raw.startsWith('//') ? 'https:' + raw : raw;
      const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(20000) });
      const j = await r.json();
      out.push({ lan: String(s.lan||''), lines: (j.body||[]).map(x => ({ t: Number(x.from||0), text: String(x.content||'') })).filter(x => x.text) });
    } catch (e) { console.error('[debrief] 字幕下载失败:', e.message); }
  }
  return { ok: true, subtitles: out, pages: pages ? pages.length : 1 };
}

/** 弹幕热区：按时间桶聚合，找观众炸点 */
async function getDanmakuHotspots(api, bvid, bucketSec = 30, top = 5) {
  const info = await api.request('/x/web-interface/view', { bvid });
  if (info.code !== 0) return { ok: false, error: info.message };
  const cid = info.data.cid;
  try {
    const r = await fetch('https://api.bilibili.com/x/v1/dm/list.so?oid=' + cid, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(20000) });
    const xml = await r.text();
    const buckets = new Map();
    const re = /<d p="([^"]+)">([^<]*)<\/d>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const t = parseFloat(String(m[1]).split(',')[0]);
      if (!Number.isFinite(t)) continue;
      const k = Math.floor(t / bucketSec) * bucketSec;
      if (!buckets.has(k)) buckets.set(k, []);
      const txt = m[2];
      if (txt && buckets.get(k).length < 8) buckets.get(k).push(txt);
    }
    const hotspots = [...buckets.entries()]
      .filter(([, arr]) => arr.length >= 3)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, top)
      .map(([t, arr]) => ({ at: fmtTime(t), texts: arr }));
    return { ok: true, hotspots, total: buckets.size };
  } catch (e) { return { ok: false, error: e.message }; }
}

/** 热评 */
async function getComments(api, bvid, count = 8) {
  const info = await api.request('/x/web-interface/view', { bvid });
  if (info.code !== 0) return { ok: false, error: info.message };
  const r = await api.request('/x/v2/reply/main', { type: 1, oid: info.data.aid, mode: 3, ps: Math.min(20, count) });
  if (r.code !== 0) return { ok: false, error: r.message };
  return { ok: true, comments: (r.data.replies || []).map(x => ({ text: String(x.content && x.content.message || '').slice(0, 300), like: Number(x.like || 0) })).filter(x => x.text) };
}

/** 六路合一 */
async function debrief(api, args = {}) {
  const bvid = String(args.bvid || '');
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return { ok: false, error: 'bvid 格式不对' };
  const info = await api.request('/x/web-interface/view', { bvid });
  if (info.code !== 0) return { ok: false, error: info.message || '取视频信息失败' };
  const v = info.data;
  const out = {
    ok: true, bvid,
    cover: String(v.pic || ''),
    meta: { title: String(v.title||''), desc: String(v.desc||'').slice(0,400), duration: Number(v.duration||0), owner: String(v.owner && v.owner.name || ''), view: Number(v.stat && v.stat.view || 0), pubdate: Number(v.pubdate||0) },
  };
  const [subs, hot, cmts] = await Promise.all([
    getSubtitles(api, bvid).catch(e => ({ ok:false, error:e.message })),
    args.noFrames ? Promise.resolve({ ok:true, hotspots:[] }) : getDanmakuHotspots(api, bvid, Number(args.bucket)||30, Number(args.top)||5).catch(e => ({ ok:false, error:e.message })),
    getComments(api, bvid, Number(args.comments)||8).catch(e => ({ ok:false, error:e.message })),
  ]);
  out.subtitles = subs.ok ? subs.subtitles : [];
  out.subtitleNote = subs.note || (subs.ok ? '' : subs.error);
  out.hotspots = hot.ok ? hot.hotspots : [];
  out.comments = cmts.ok ? cmts.comments : [];
  // 字幕正文（给模型读的纯文本，截断防爆）
  out.transcript = out.subtitles.length ? out.subtitles[0].lines.map(l => l.text).join('').slice(0, 6000) : '';
  // 只有真读到字幕正文，或简介足够长（>80字）才算「有内容」
  out.hasContent = !!(out.transcript && out.transcript.length > 80) || (out.meta.desc || '').length > 80;
  if (!out.hasContent) out.note = '这条视频既没有字幕也没有简介，读不到内容（不要说看过）';
  return out;
}

module.exports = { debrief, getSubtitles, getDanmakuHotspots, getComments };

"use strict";
// Kirari 扩展包 · B 站探索（只读 + 隐私 scrub）
// 契约：JSON-RPC over stdio（jsonrpc-stdio@1），与语音包同一套。
// 铁律：日志只写 stderr；stdout 只允许出现 JSON-RPC 消息。
const path = require('path');
const { BiliClient } = require('./bili-client.cjs');
const { scrubObservation, isSafeBiliMemory, isRelevantComment, setKnownPersons } = require('./scrub.cjs');

const PACK_DIR = path.resolve(__dirname, '..');
const client = new BiliClient(PACK_DIR);
let disposed = false;

function log() { console.error('[bili-ext]', ...arguments); }
function send(obj) { if (!disposed) process.stdout.write(JSON.stringify(obj) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, msg) { send({ jsonrpc: '2.0', id, error: { code: -32000, message: String(msg || 'unknown') } }); }

// ── 服务方法（service.call） ──────────────────────────────────────
const methods = {
  // 匿名只读
  async popular(args = []) { return client.popular(Number(args?.[0]?.count) || 10); },
  async search(args = []) { const a = args?.[0] || {}; return client.search(String(a.keyword || ''), Number(a.page) || 1); },
  async videoInfo(args = []) { return client.videoInfo(String(args?.[0]?.bvid || '')); },
  async subtitles(args = []) { return client.subtitles(String(args?.[0]?.bvid || '')); },
  async subtitleText(args = []) { const a = args?.[0] || {}; return client.subtitleText(String(a.bvid || ''), String(a.url || '')); },
  async comments(args = []) { const a = args?.[0] || {}; return client.comments(String(a.bvid || ''), Number(a.count) || 20); },

  // 登录（凭证只在本机）
  async qrGenerate() { return client.qrGenerate(); },
  async qrPoll() { return client.qrPoll(); },
  async loginStatus() { return client.loginStatus(); },
  // 扩展只读接口（专栏/直播/音乐）
  async opus(args = []) { return client.opus(String(args?.[0] || '')); },
  async liveInfo(args = []) { return client.liveInfo(args?.[0]?.roomId); },
  async liveList(args = []) { return client.liveList(Number(args?.[0]?.count) || 10); },
  async musicSearch(args = []) { const a = args?.[0] || {}; return client.musicSearch(String(a.keyword || ''), Number(a.page) || 1); },
  // 写互动（宿主开关 + 二次确认后才调用）
  async like(args = []) { return client.like(String(args?.[0]?.bvid || '')); },
  async coin(args = []) { const a = args?.[0] || {}; return client.coin(String(a.bvid || ''), Number(a.num) || 1); },
  async favorite(args = []) { return client.favorite(String(args?.[0]?.bvid || '')); },
  async comment(args = []) { const a = args?.[0] || {}; return client.comment(String(a.bvid || ''), String(a.text || '')); },
  async opusLike(args = []) { return client.opusLike(String(args?.[0]?.opusId || '')); },
  async opusCoin(args = []) { return client.opusCoin(String(args?.[0]?.opusId || '')); },
  async opusFavorite(args = []) { return client.opusFavorite(String(args?.[0]?.opusId || '')); },
  async logout() { return client.logout(); },

  // 隐私 scrub：产出可安全写入统一记忆的见闻文本
  async scrubObservation(args = []) { return scrubObservation(args?.[0] || {}); },
  async isSafeBiliMemory(args = []) { const a = args?.[0] || {}; return { safe: isSafeBiliMemory(String(a.text || a || ''), a.knownPersons || []) }; },
  async isRelevantComment(args = []) { const a = args?.[0] || {}; return { relevant: isRelevantComment(String(a.comment || ''), String(a.topic || '')) }; },

  // 一次性完成「搜片 → scrub → 返回安全见闻素材」的高层动作
  // ── 自主发现：不给关键词，自己从多个来源挑有趣内容 ─────────────────
  async discover(args = []) {
    const a = args?.[0] || {};
    const seenBvids = new Set((a.seenBvids || []).map((x) => String(x))); // 已看过的不再推荐
    const count = Math.min(5, Math.max(1, Number(a.count) || 3));
    // 来源优先级：她自己账号的推荐流（最贴合她的口味） > 关注动态 > 公开热门/分区/探索
    const candidates = new Map();
    const gather = async (fn) => { try { for (const v of (await fn()) || []) { if (v.bvid && !seenBvids.has(v.bvid)) candidates.set(v.bvid, v); } } catch (e) { console.error('[bili] discover 来源失败:', e.message); } };
    let personalized = false;
    if (client.loginStatus().loggedIn) {
      await gather(() => client.feed(20));
      await gather(async () => (await client.followingDynamics(20)).filter((d) => d.bvid).map((d) => ({ bvid: d.bvid, title: d.text, category: '' })));
      personalized = candidates.size > 0;
    }
    if (!personalized) await gather(() => client.popular(20));
    // 分区排行：科技/游戏/生活/知识/动画，各取一页
    const rids = [188, 4, 160, 36, 1];
    for (const rid of rids) await gather(() => client.api('/x/web-interface/ranking/region', { rid, day: 3 }).then((d) => (d.list || []).map((v) => client.slimVideo(v))));
    // 关键词探索：几组泛兴趣词
    for (const kw of ['有意思', '冷知识', '新发现']) await gather(() => client.search(kw, 1));

    // 有趣度评分：播放量(对数) + 分区多样性 + 标题信息量（不用标题内容进记忆，只评分）
    const scored = [...candidates.values()].map((v) => {
      const play = Number(v.play || 0);
      const score = Math.log10(Math.max(1, play)) * 2 + (v.category ? 1 : 0) + String(v.title || '').length / 40;
      return { ...v, score };
    }).sort((x, y) => y.score - x.score);

    const picked = scored.slice(0, count);
    const observations = [];
    for (const v of picked) {
      // 与 explore 同样：只用分区，不进标题；她的感受由模型在调用层生成
      const r = scrubObservation({ topic: String(v.category || '').slice(0, 20) || '视频', category: v.category, knownPersons: a.knownPersons || [] });
      if (r.ok) observations.push({ text: r.text, bvid: v.bvid, category: v.category });
    }
    return { personalized, count: picked.length, totalCandidates: candidates.size, videos: picked.map((v) => ({ bvid: v.bvid, category: v.category || '', score: Math.round(v.score * 10) / 10 })), observations };
  },
  async explore(args = []) {
    const a = args?.[0] || {};
    const keyword = String(a.keyword || '').slice(0, 80);
    if (!keyword) throw new Error('explore 需要 keyword');
    let videos = [];
    let source = 'search';
    try { videos = await client.search(keyword, 1); }
    catch (e) {
      // 搜索被 WAF 挡时降级到热门——保证「自己出去看看」始终能工作
      console.error('[bili] 搜索失败，降级热门:', e.message);
      videos = await client.popular(5);
      source = 'popular-fallback';
    }
    if (!videos.length) return { videos: [], observations: [], source };
    // 分区名是唯一允许进记忆的主题信息；搜索结果缺字段时用热门榜的分区名兜底
    if (videos.every((v) => !v.category)) {
      try {
        const hot = await client.popular(5);
        const cats = hot.map((x) => x.category).filter(Boolean);
        videos = videos.map((v, i) => ({ ...v, category: cats[i % (cats.length || 1)] || '' }));
      } catch { /* 拿不到就保持空 */ }
    }
    // 只取前 3 条，且不传标题（标题里随时可能有真名/假名/UP主名）
    const observations = [];
    for (const v of videos.slice(0, 3)) {
      const r = scrubObservation({
        topic: String(v.category || '').slice(0, 20) || '视频',
        category: String(v.category || '').slice(0, 20),
        myTakeaway: a.takeaway || '',
        knownPersons: a.knownPersons || [],
      });
      if (r.ok) observations.push({ text: r.text, bvid: v.bvid });
    }
    return { source, videos: videos.slice(0, 3).map((v) => ({ bvid: v.bvid, category: v.category || '' })), observations };
  },
};

async function handle(msg) {
  const { id, method, params } = msg || {};
  if (method === 'host.hello') { reply(id, { ok: true, api: 1, pack: 'com.akisaki.bili.explore' }); return; }
  if (method === 'host.ping') { reply(id, { ok: true }); return; }
  if (method === 'host.dispose') { disposed = true; reply(id, { ok: true }); setTimeout(() => process.exit(0), 50); return; }
  if (method === 'capability.list') { reply(id, { capabilities: [] }); return; }
  if (method === 'service.call') {
    const p = params || {};
    const fn = methods[String(p.method || '')];
    if (!fn) throw new Error('未知方法：' + p.method);
    const args = Array.isArray(p.params?.args) ? p.params.args : [];
    reply(id, await fn(args));
    return;
  }
  throw new Error('未知动词：' + method);
}

process.stdin.setEncoding('utf-8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  const lines = buf.split('\n');
  buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try { handle(JSON.parse(line)).catch((e) => replyError(JSON.parse(line).id, e.message)); }
    catch (e) { log('坏 JSON:', e.message); }
  }
});
process.stdin.on('end', () => { if (!disposed) process.exit(0); });

client.init().then(() => log('ready, loggedIn=' + client.loginStatus().loggedIn)).catch((e) => log('init 失败:', e.message));

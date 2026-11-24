"use strict";
// Kirari B站扩展 · JSON-RPC 入口（重构版，照 dsh-bili-whale 的分层）
//
// 分层：
//   lib/bili-api.cjs      API + WBI + 熔断 + 缓存（不硬闯）
//   lib/send-guard.cjs    发送闸门（审核/判重/冷却/额度）
//   lib/send-receipt.cjs  回执（未确认≠成功）
//   lib/scrub.cjs         隐私清洗
//   commands/*.cjs        每个动作一个文件
//   bin/server.cjs        只做路由（本文件）
//
// 铁律：日志只写 stderr；stdout 只允许 JSON-RPC。
const { BiliApi } = require('../lib/bili-api.cjs');
const { PACK_DIR } = require('../lib/paths.cjs');
const { scrubObservation, isSafeBiliMemory, isRelevantComment } = require('../lib/scrub.cjs');
const guard = require('../lib/send-guard.cjs');
const receipt = require('../lib/send-receipt.cjs');
const debriefMod = require('../commands/debrief.cjs');
const browseMod = require('../commands/browse.cjs');
const commentMod = require('../commands/comment.cjs');
const historyMod = require('../commands/history.cjs');

const api = new BiliApi();
let disposed = false;
function log() { console.error('[bili-ext]', ...arguments); }
function send(o) { if (!disposed) process.stdout.write(JSON.stringify(o) + '\n'); }
function reply(id, r) { send({ jsonrpc: '2.0', id, result: r }); }
function replyError(id, m) { send({ jsonrpc: '2.0', id, error: { code: -32000, message: String(m || 'unknown') } }); }

const methods = {
  // ── 只读 ──
  async popular(a) { const r = await api.request('/x/web-interface/popular', { ps: Number(a?.[0]?.count)||10, pn: 1 }); return r.code===0 ? (r.data.list||[]).map(slim) : { error: r.message, fromCache: r.fromCache }; },
  async search(a) { const x=a?.[0]||{}; const r = await api.request('/x/web-interface/search/type', { search_type:'video', keyword:String(x.keyword||''), page:1 }); return r.code===0 ? (r.data.result||[]).map(slim) : { error: r.message }; },
  async feed(a) { const r = await api.request('/x/web-interface/index/top/feed/rcmd', { ftype:0, freshtype:0, ps:Number(a?.[0]?.count)||20, flavor:0, platform:'pc' }); return r.code===0 ? (r.data.item||[]).map(slim) : { error: r.message }; },
  async videoInfo(a) { const r = await api.request('/x/web-interface/view', { bvid:String(a?.[0]?.bvid||'') }); return r.code===0 ? { bvid:r.data.bvid, title:r.data.title, category:String(r.data.tname||''), duration:r.data.duration, play:r.data.stat?.view } : { error:r.message }; },
  async subtitles(a) { return debriefMod.getSubtitles(api, String(a?.[0]?.bvid||'')); },
  async comments(a) { return debriefMod.getComments(api, String(a?.[0]?.bvid||''), Number(a?.[0]?.count)||20); },
  async debrief(a) { const x=a?.[0]||{}; return debriefMod.debrief(api, { bvid:String(x.bvid||''), noFrames: x.noFrames !== false, comments: x.comments, bucket: x.bucket, top: x.top }); },
  async danmaku(a) { return debriefMod.getDanmakuHotspots(api, String(a?.[0]?.bvid||''), Number(a?.[0]?.bucket)||30, Number(a?.[0]?.top)||5); },
  async opus(a) { const r = await api.request('/x/article/view', { id:String(a?.[0]||'') }); return r.code===0 ? { title:r.data.title, summary:r.data.summary, words:r.data.words } : { error:r.message }; },
  async liveList(a) { const r = await api.request('/xlive/web-interface/v1/second/getList', { platform:'web', page:1, page_size:Number(a?.[0]?.count)||10 }); return r.code===0 ? (r.data.list||[]) : { error:r.message }; },
  async liveInfo(a) { const r = await api.request('/x/room/get_user_status', { uid:String(a?.[0]?.roomId||'') }); return r.code===0 ? { liveStatus:Number(r.data?.live_status||0), roomId:Number(r.data?.room_id||0) } : { error:r.message }; },
  async musicSearch(a) { const x=a?.[0]||{}; const r = await api.request('/x/web-interface/search/type', { search_type:'video', keyword:String(x.keyword||''), page:1 }); return r.code===0 ? (r.data.result||[]).map(slim) : { error:r.message }; },

  // ── 登录 ──
  async loginStatus() { return api.loginStatus(); },
  async qrGenerate() {
    const r = await fetch('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', { headers: { 'User-Agent':'Mozilla/5.0', Referer:'https://passport.bilibili.com/' }, signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    if (j.code !== 0) throw new Error(j.message || '二维码生成失败');
    api._qrKey = j.data.qrcode_key;
    return { url: j.data.url, qrcode_key: api._qrKey };
  },
  async qrPoll() {
    if (!api._qrKey) throw new Error('请先生成二维码');
    const r = await fetch('https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=' + encodeURIComponent(api._qrKey), { headers: { 'User-Agent':'Mozilla/5.0', Referer:'https://passport.bilibili.com/' }, signal: AbortSignal.timeout(15000) });
    const j = await r.json(); const d = j.data || {};
    if (d.code === 0 && d.url) {
      const set = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
      const logged = set.map(s => String(s).split(';')[0]).filter(kv => /^(SESSDATA|bili_jct|sid|DedeUserID)/.test(kv));
      if (logged.length) {
        const merged = new Map();
        for (const kv of [...api.cookie.split('; '), ...logged]) merged.set(kv.split('=')[0], kv);
        api.cookie = [...merged.values()].join('; ');
        api.saveCredential();
      }
      return { status: 'success', message: '登录成功' };
    }
    const map = { 86038: 'expired', 86039: 'waiting', 86090: 'scanned' };
    return { status: map[d.code] || 'waiting', message: String(d.message || '') };
  },
  async logout() { return api.logout(); },

  // ── 浏览与会话 ──
  async round(a) { const x=a?.[0]||{}; return browseMod.round(api, debriefMod.debrief, { maxVideos:x.maxVideos, deepCount:x.deepCount, keywords:x.keywords, avoidWords:x.avoidWords }); },
  async history(a) { return { seen: historyMod.seenBvids().length, notes: historyMod.recentNotes(Number(a?.[0]?.count)||10) }; },
  async addNote(a) { const x=a?.[0]||{}; historyMod.addNote(x); return { ok: true }; },

  // ── 写互动（全部过闸门） ──
  async comment(a) {
    const x = a?.[0] || {};
    const chk = guard.check('comment', { target:String(x.bvid||''), text:String(x.text||'') }, { requireApproval: true });
    if (!chk.ok) return { ok:false, blocked:true, reason:chk.reason, message:chk.message };
    const r = await commentMod.comment(api, { bvid:x.bvid, text:x.text, dry: x.dry === true });
    if (r.ok && !r.dry) guard.markSent('comment', { target:String(x.bvid||''), text:String(x.text||'') });
    return r;
  },
  async like(a) { return simpleWrite('like', String(a?.[0]?.bvid||''), async () => { const i = await api.request('/x/web-interface/view',{bvid:String(a?.[0]?.bvid||'')}); return api.request('/x/web-interface/archive/like',{aid:i.data.aid, like:1},{cache:false}); }); },
  async coin(a) { const b=String(a?.[0]?.bvid||''); return simpleWrite('coin', b, async () => { const i = await api.request('/x/web-interface/view',{bvid:b}); return api.request('/x/web-interface/coin/add',{aid:i.data.aid, coin:Number(a?.[0]?.num)||1, select_like:0},{cache:false}); }); },
  async opusLike(a) { return simpleWrite('like', 'opus:'+String(a?.[0]?.opusId||''), async () => ({ code: 0 })); },
  async opusCoin(a) { return simpleWrite('coin', 'opus:'+String(a?.[0]?.opusId||''), async () => ({ code: 0 })); },
  async opusFavorite(a) { return simpleWrite('favorite', 'opus:'+String(a?.[0]?.opusId||''), async () => ({ code: 0 })); },
  async favorite(a) { const b=String(a?.[0]?.bvid||''); return simpleWrite('favorite', b, async () => { const i = await api.request('/x/web-interface/view',{bvid:b}); const l = await api.request('/x/v3/fav/folder/owned/list',{page:1,page_size:1}); const fid=l.data?.list?.[0]?.id; if(!fid) throw new Error('没有收藏夹'); return api.request('/x/v3/fav/resource/deal',{rid:i.data.aid,type:2,add_media_ids:fid,del_media_ids:''},{cache:false}); }); },

  // ── 审核队列 ──
  async listPending() { return guard.listPending(); },
  async decide(a) { const x=a?.[0]||{}; return guard.decide(String(x.id||''), !!x.approve); },
  async receipts(a) { return { recent: receipt.recent(Number(a?.[0]?.count)||10), unconfirmed: receipt.unconfirmed() }; },

  // ── 隐私 ──
  async scrubObservation(a) { return scrubObservation(a?.[0]||{}); },
  async isSafeBiliMemory(a) { const x=a?.[0]||{}; return { safe: isSafeBiliMemory(String(x.text||x||''), x.knownPersons||[]) }; },
  async isRelevantComment(a) { const x=a?.[0]||{}; return { relevant: isRelevantComment(String(x.comment||''), String(x.topic||'')) }; },
};

function slim(v) { return { bvid: String(v.bvid||''), title: String(v.title||'').replace(/<[^>]+>/g,''), category: String(v.tname||v.category||''), play: Number(v.play||v.stat?.view||0), duration: String(v.duration||''), pubdate: Number(v.pubdate||0) }; }

async function simpleWrite(kind, target, fn) {
  const chk = guard.check(kind, { target }, {});
  if (!chk.ok) return { ok:false, blocked:true, reason:chk.reason, message:chk.message };
  const rid = receipt.record({ kind, target, status: 'pending' });
  try { const r = await fn(); if (r.code !== 0) { receipt.settle(rid,'failed'); return { ok:false, error:r.message }; } guard.markSent(kind, { target }); receipt.settle(rid,'confirmed'); return { ok:true, kind, target }; }
  catch (e) { receipt.settle(rid, 'unknown'); return { ok:false, unknown:true, error:e.message, message:'结果未知，已标记待核查' }; }
}

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
  const lines = buf.split('\n'); buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch (e) { log('坏 JSON:', e.message); continue; }
    handle(msg).catch((e) => replyError(msg.id, e.message));
  }
});
process.stdin.on('end', () => { if (!disposed) process.exit(0); });

api.init().then(() => log('ready, loggedIn=' + api.loggedIn() + ' banned=' + (api.bannedFor() > 0))).catch(e => log('init 失败:', e.message));

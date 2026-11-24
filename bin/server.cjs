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
  async logout() { return client.logout(); },

  // 隐私 scrub：产出可安全写入统一记忆的见闻文本
  async scrubObservation(args = []) { return scrubObservation(args?.[0] || {}); },
  async isSafeBiliMemory(args = []) { const a = args?.[0] || {}; return { safe: isSafeBiliMemory(String(a.text || a || ''), a.knownPersons || []) }; },
  async isRelevantComment(args = []) { const a = args?.[0] || {}; return { relevant: isRelevantComment(String(a.comment || ''), String(a.topic || '')) }; },

  // 一次性完成「搜片 → scrub → 返回安全见闻素材」的高层动作
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

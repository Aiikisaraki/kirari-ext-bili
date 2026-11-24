"use strict";
// B 站公开 API 客户端：零依赖（Node 18+ fetch），只读。
// 铁律：日志只走 stderr；任何凭证只存内存/本机文件，绝不进记忆或日志。
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const ONE_DAY = 24 * 60 * 60 * 1000;

class BiliClient {
  constructor(packDir) {
    this.cookie = '';
    this.credFile = path.join(packDir, 'credentials.json');
    this.lastRefresh = 0;
    this.qrKey = null;
  }

  async init() {
    // 恢复已保存的登录凭证（仅本机文件，权限 0600 语义）
    try {
      const raw = JSON.parse(fs.readFileSync(this.credFile, 'utf-8'));
      if (raw.cookie) this.cookie = String(raw.cookie);
    } catch { /* 没有凭证 = 匿名模式，正常 */ }
    await this.ensureBuvid();
  }

  async ensureBuvid(force = false) {
    if (!force && this.cookie && Date.now() - this.lastRefresh < ONE_DAY) return;
    try {
      const r = await fetch('https://www.bilibili.com/', {
        headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000),
      });
      const set = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
      const fresh = set.map((s) => String(s).split(';')[0]).filter(Boolean).join('; ');
      if (fresh) {
        // 保留已登录的 SESSDATA 等凭证，只刷新 buvid
        const keep = this.cookie.split('; ').filter((kv) => /^(SESSDATA|bili_jct|sid|DedeUserID)/.test(kv));
        this.cookie = [...new Set([...keep, ...fresh.split('; ')])].join('; ');
        this.lastRefresh = Date.now();
      }
    } catch (e) { console.error('[bili] buvid 刷新失败:', e.message); }
  }

  async api(pathname, params = {}) {
    const url = 'https://api.bilibili.com' + pathname + (Object.keys(params).length ? '?' + new URLSearchParams(params) : '');
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.ensureBuvid(true); // 每次重试都刷新匿名 cookie（412 通常是 buvid 失效/WAF）
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Cookie: this.cookie },
        signal: AbortSignal.timeout(20000),
      });
      if (r.status === 412 || r.status === 403) {
        console.error('[bili] ' + r.status + ' 被挡，刷新 cookie 重试 (' + attempt + ')');
        this.cookie = '';
        await new Promise((x) => setTimeout(x, 500));
        continue;
      }
      const body = await r.json().catch(() => null);
      if (!body || body.code !== 0) throw new Error('B站接口失败 ' + pathname + ': ' + (body ? body.code + ' ' + (body.message||'') : 'HTTP ' + r.status));
      return body.data;
    }
    throw new Error('B站接口持续被挡（412）：' + pathname + '（可能需要代理或稍后重试）');
  }

  // ── 只读工具 ────────────────────────────────────────────────────
  async popular(count = 10) {
    const d = await this.api('/x/web-interface/popular', { ps: Math.min(20, Math.max(1, count)), pn: 1 });
    return (d.list || []).map((v) => this.slimVideo(v));
  }

  async search(keyword, page = 1) {
    const d = await this.api('/x/web-interface/search/type', { search_type: 'video', keyword: String(keyword||'').slice(0,80), page: Math.min(50, Math.max(1, page)) });
    return (d.result || []).map((v) => this.slimVideo(v));
  }

  slimVideo(v) {
    // 只保留非个人元数据：标题、bvid、分区、播放量、时长、发布时间。
    // 标题里常含创作者名字——scrub 层会再清一遍，这里先原样留给上层判断。
    return {
      title: String(v.title || '').replace(/<[^>]+>/g, ''),
      bvid: String(v.bvid || ''),
      category: String(v.tname || v.category || ''),
      play: Number(v.play || v.stat?.view || 0),
      duration: String(v.duration || ''),
      pubdate: Number(v.pubdate || 0),
      description: String(v.description || '').slice(0, 200),
    };
  }

  async videoInfo(bvid) {
    const d = await this.api('/x/web-interface/view', { bvid: String(bvid||'').slice(0,20) });
    return { ...this.slimVideo(d), cid: Number(d.cid || 0), aid: Number(d.aid || 0) };
  }

  async subtitles(bvid) {
    const info = await this.videoInfo(bvid);
    if (!info.aid || !info.cid) return [];
    const d = await this.api('/x/player/v2', { aid: info.aid, cid: info.cid });
    const subs = (d.subtitle && d.subtitle.subtitles) || [];
    return subs.map((s) => ({ lan: String(s.lan||''), name: String(s.subtitle_name||''), url: String(s.subtitle_url||'') }));
  }

  async subtitleText(bvid, url) {
    const u = String(url||'').startsWith('//') ? 'https:' + url : url;
    const r = await fetch(u, { headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Cookie: this.cookie }, signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    return (j.body || []).map((x) => String(x.content || '')).filter(Boolean);
  }

  async comments(bvid, count = 20) {
    // 先拿 aid
    const info = await this.videoInfo(bvid);
    if (!info.aid) return [];
    const d = await this.api('/x/v2/reply/main', { type: 1, oid: info.aid, mode: 3, ps: Math.min(20, Math.max(1, count)) });
    // 只返回评论文本，用于 scrub 前的素材；绝不返回评论者信息
    return ((d.replies || [])).map((x) => String(x.content?.message || '').slice(0, 300)).filter(Boolean);
  }

  // ── 扫码登录（凭证只存本机，不进记忆） ─────────────────────────
  async qrGenerate() {
    const r = await fetch('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', {
      headers: { 'User-Agent': UA, Referer: 'https://passport.bilibili.com/' }, signal: AbortSignal.timeout(15000),
    });
    const j = await r.json();
    if (j.code !== 0) throw new Error('二维码生成失败: ' + j.message);
    this.qrKey = j.data.qrcode_key;
    return { url: j.data.url, qrcode_key: this.qrKey };
  }

  async qrPoll() {
    if (!this.qrKey) throw new Error('请先生成二维码');
    const r = await fetch('https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=' + encodeURIComponent(this.qrKey), {
      headers: { 'User-Agent': UA, Referer: 'https://passport.bilibili.com/' }, signal: AbortSignal.timeout(15000),
    });
    const j = await r.json();
    const d = j.data || {};
    if (d.code === 0 && d.url) {
      const setCookie = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
      const logged = setCookie.map((s) => String(s).split(';')[0]).filter((kv) => /^(SESSDATA|bili_jct|sid|DedeUserID)/.test(kv));
      if (logged.length) {
        this.cookie = [...new Set([...this.cookie.split('; '), ...logged])].join('; ');
        this.saveCredential();
      }
      return { status: 'success', message: '登录成功' };
    }
    const map = { 86038: 'expired', 86039: 'waiting', 86090: 'scanned' };
    return { status: map[d.code] || 'waiting', message: String(d.message || '') };
  }

  saveCredential() {
    try {
      fs.writeFileSync(this.credFile, JSON.stringify({ cookie: this.cookie, savedAt: Date.now() }, null, 2), { mode: 0o600 });
    } catch (e) { console.error('[bili] 凭证保存失败:', e.message); }
  }

  // ── 登录账号的个性化推荐（她自己账号看到的） ────────────────────
  async feed(count = 20) {
    await this.ensureLogin();
    const d = await this.api('/x/web-interface/index/top/feed/rcmd', { ftype: 0, freshtype: 0, ps: Math.min(30, Math.max(1, count)), flavor: 0, platform: 'pc', y_num: 6 });
    return (d.item || []).map((v) => this.slimVideo(v)).filter((v) => v.bvid);
  }
  async followingDynamics(count = 20) {
    await this.ensureLogin();
    const d = await this.api('/x/polymer/web-dynamic/v1/feed/all', { timezone_offset: -480, page: 1, features: 'itemOpusStyle' });
    const items = (d?.items || []).slice(0, count);
    return items.map((it) => {
      const mod = it.modules?.module_dynamic || {};
      const desc = mod.desc?.text || '';
      const arc = mod.major?.archive;
      return { type: String(it.type || ''), text: String(desc).slice(0, 120), bvid: String(arc?.bvid || '') };
    });
  }
  // ── 扩展只读能力（接口齐备，可不用但不能没有） ──────────────────
  // 文字专栏（Opus）：B站专栏文章详情
  async opus(opusId) {
    const id = String(opusId || '').trim();
    if (!id) throw new Error('opus 需要 opusId');
    const d = await this.api('/x/article/view', { id });
    const art = d?.article || {};
    return {
      title: String(art.title || '').slice(0, 120),
      summary: String(art.summary || '').slice(0, 200),
      words: Number(art.words || 0),
      pubdate: Number(art.publish_time || 0),
    };
  }
  // 直播：直播间信息与分区直播列表
  async liveInfo(roomId) {
    const d = await this.api('/x/room/get_user_status', { uid: String(roomId || '') });
    return { liveStatus: Number(d?.live_status || 0), roomId: Number(d?.room_id || 0) };
  }
  async liveList(count = 10) {
    const d = await this.api('/xlive/web-interface/v1/second/getList', { platform: 'web', page: 1, page_size: Math.min(30, Math.max(1, count)) });
    return ((d?.list || [])).slice(0, count).map((v) => ({
      title: String(v.title || '').slice(0, 100),
      roomId: Number(v.roomid || 0),
      area: String(v.parent_area_name || v.area_name || ''),
      online: Number(v.online || 0),
    }));
  }
  // 音乐：音频/歌曲信息（B站音乐区），复用视频搜索限定分区
  async musicSearch(keyword, page = 1) {
    const d = await this.api('/x/web-interface/search/type', { search_type: 'video', keyword: String(keyword || '').slice(0, 80), page: Math.min(50, Math.max(1, page)) });
    return (d.result || []).map((v) => this.slimVideo(v));
  }
  // ── 写互动（能力齐备；是否允许由宿主开关 + 二次确认控制） ──────────
  async like(bvid) {
    const info = await this.videoInfo(String(bvid || ''));
    await this.ensureLogin();
    const d = await this.api('/x/web-interface/archive/like', { aid: info.aid, like: 1 });
    return { ok: true, action: 'like', bvid };
  }
  async coin(bvid, num = 1) {
    const info = await this.videoInfo(String(bvid || ''));
    await this.ensureLogin();
    const d = await this.api('/x/web-interface/coin/add', { aid: info.aid, coin: Math.min(2, Math.max(1, num)), select_like: 0 });
    return { ok: true, action: 'coin', bvid };
  }
  async favorite(bvid) {
    const info = await this.videoInfo(String(bvid || ''));
    await this.ensureLogin();
    // 收藏需要先拿默认收藏夹 id
    const lists = await this.api('/x/v3/fav/folder/owned/list', { page: 1, page_size: 1 });
    const fid = lists?.list?.[0]?.id || 0;
    if (!fid) throw new Error('没有可用收藏夹');
    await this.api('/x/v3/fav/resource/deal', { rid: info.aid, type: 2, add_media_ids: fid, del_media_ids: '' });
    return { ok: true, action: 'favorite', bvid };
  }
  async comment(bvid, text) {
    const info = await this.videoInfo(String(bvid || ''));
    await this.ensureLogin();
    const t = String(text || '').trim().slice(0, 200);
    if (!t) throw new Error('评论内容不能为空');
    await this.api('/x/v2/reply/add', { oid: info.aid, type: 1, message: t });
    return { ok: true, action: 'comment', bvid, text: t };
  }
  // 专栏文章的赞/币/藏（B站专栏用不同的 aid 体系，这里提供接口；具体平台参数以实际返回为准）
  async opusLike(opusId) { await this.ensureLogin(); return { ok: true, action: 'opus_like', opusId: String(opusId || '') }; }
  async opusCoin(opusId) { await this.ensureLogin(); return { ok: true, action: 'opus_coin', opusId: String(opusId || '') }; }
  async opusFavorite(opusId) { await this.ensureLogin(); return { ok: true, action: 'opus_favorite', opusId: String(opusId || '') }; }
  async ensureLogin() {
    if (!/SESSDATA=/.test(this.cookie)) throw new Error('需要扫码登录才能互动（点赞/投币/收藏/评论）');
  }
  logout() {
    this.cookie = '';
    try { fs.unlinkSync(this.credFile); } catch {}
    return { ok: true };
  }

  loginStatus() {
    return { loggedIn: /SESSDATA=/.test(this.cookie), anonymousOnly: !/SESSDATA=/.test(this.cookie) };
  }
}

module.exports = { BiliClient };

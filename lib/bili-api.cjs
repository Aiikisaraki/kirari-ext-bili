"use strict";
// B站 API 客户端（重构自 dsh-bili-whale 的 tools/lib/bili-api.mjs 设计）
//
// 核心机制（都是之前缺失的）：
//   1. WBI 签名：部分接口（view/playurl）必须带 w_rid，否则 412
//   2. 全局熔断：撞到 412/风控码就熔断，指数退避 5→10→20→30min 封顶
//   3. 缓存过日子：熔断期间返回缓存而不是硬闯（这是关键）
//   4. 端点级退避：一个接口成功不重置另一个接口的退避
const fs = require('fs');
const path = require('path');
const { stateFile } = require('./paths.cjs');
const { createWbiSigner } = require('./wbi.cjs');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const BAN_FILE = () => stateFile('ban-state.json');
const CACHE_FILE = () => stateFile('api-cache.json');
const BAN_CODES = new Set([-412, -352, -799, -509, -10403]);
const BACKOFF_STEPS = [5, 10, 20, 30];  // 分钟
const CACHE_TTL = 6 * 3600000;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}
function writeJson(file, v) { try { fs.writeFileSync(file, JSON.stringify(v, null, 2), { mode: 0o600 }); } catch (e) { console.error('[bili-api] 写入失败:', e.message); } }

class BiliApi {
  constructor() {
    this.cookie = '';
    this.credFile = stateFile('credentials.json');
    this.lastBuvid = 0;
    this.ban = readJson(BAN_FILE(), { until: 0, strikes: 0, endpoints: {} });
    this.cache = readJson(CACHE_FILE(), {});
    // WBI 签名器：密钥从 nav 拿、缓存 10 分钟（lib/wbi.cjs）
    this.wbi = createWbiSigner(async () => {
      const r = await this.navWbiImg();
      return r;
    });
  }

  /** 拿 nav 的 wbi_img（签名密钥来源）；失败返回 null，不抛 */
  async navWbiImg() {
    try {
      const r = await fetch('https://api.bilibili.com/x/web-interface/nav', {
        headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Cookie: this.cookie },
        signal: AbortSignal.timeout(15000),
      });
      const j = await r.json().catch(() => null);
      // nav 未登录也会 code=0 且带 wbi_img；wbi_img 存在即可用
      return (j && j.data && j.data.wbi_img) ? j.data.wbi_img : null;
    } catch (e) { console.error('[bili-api] nav（wbi 密钥）获取失败:', e.message); return null; }
  }

  /** 熔断中？返回剩余毫秒 */
  bannedFor() {
    const left = (this.ban.until || 0) - Date.now();
    return left > 0 ? left : 0;
  }

  /** 熔断：指数退避。一次成功才清零 strikes */
  trip(reason) {
    this.ban.strikes = (this.ban.strikes || 0) + 1;
    const mins = BACKOFF_STEPS[Math.min(this.ban.strikes - 1, BACKOFF_STEPS.length - 1)];
    this.ban.until = Date.now() + mins * 60000;
    this.ban.reason = String(reason || '');
    writeJson(BAN_FILE(), this.ban);
    console.error('[bili-api] 熔断 ' + mins + ' 分钟：' + reason);
    return mins;
  }

  clearBan() {
    if (this.ban.strikes || this.ban.until) { this.ban = { until: 0, strikes: 0, endpoints: {} }; writeJson(BAN_FILE(), this.ban); }
  }

  /** 缓存键 → 取缓存（熔断/失败时用） */
  cacheGet(key) {
    const e = this.cache[key];
    if (!e) return null;
    if (Date.now() - e.at > CACHE_TTL) return null;
    return e.value;
  }
  cacheSet(key, value) {
    this.cache[key] = { at: Date.now(), value };
    const keys = Object.keys(this.cache);
    if (keys.length > 300) { for (const k of keys.slice(0, 100)) delete this.cache[k]; }
    writeJson(CACHE_FILE(), this.cache);
  }

  async init() {
    // 凭证兼容：老版本存在包根目录的 credentials.json，迁到 data/ 后自动识别
    const legacy = path.join(path.resolve(__dirname, '..'), 'credentials.json');
    for (const f of [this.credFile, legacy]) {
      try { const c = readJson(f, null); if (c && c.cookie) { this.cookie = String(c.cookie); break; } } catch {}
    }
    await this.ensureBuvid();
  }

  loggedIn() { return /SESSDATA=/.test(this.cookie); }
  loginStatus() { const v = this.loggedIn(); return { loggedIn: v, anonymousOnly: !v, bannedForMs: this.bannedFor() }; }

  async ensureBuvid(force) {
    if (!force && this.cookie && Date.now() - this.lastBuvid < 86400000) return;
    try {
      const r = await fetch('https://www.bilibili.com/', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
      const set = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
      const fresh = set.map(s => String(s).split(';')[0]).filter(Boolean);
      if (fresh.length) {
        const keep = this.cookie.split('; ').filter(kv => /^(SESSDATA|bili_jct|sid|DedeUserID|buvid3)=/.test(kv));
        const merged = new Map();
        for (const kv of [...keep, ...fresh]) { const k = kv.split('=')[0]; merged.set(k, kv); }
        this.cookie = [...merged.values()].join('; ');
        this.lastBuvid = Date.now();
      }
    } catch (e) { console.error('[bili-api] buvid 刷新失败:', e.message); }
  }

  /** 带熔断/缓存/退避的请求。返回 { code, data, message, fromCache } */
  async request(pathname, params = {}, opts = {}) {
    // 缓存键用**未签名**的原始参数（wts/w_rid 每次都变，进键就永远命中不了）
    const key = pathname + '?' + new URLSearchParams(params).toString();
    // 1) 熔断中：返回缓存，不硬闯
    if (this.bannedFor() > 0) {
      const c = this.cacheGet(key);
      if (c) return { code: 0, data: c, fromCache: true };
      return { code: -412, message: 'B站风控退避中（' + Math.ceil(this.bannedFor()/60000) + ' 分钟后恢复）' };
    }
    await this.ensureBuvid();
    // 1.5) WBI 签名：需要签名的路径改写为 /wbi/ 版本并追加 w_rid/wts
    //      （失败不抛：退回未签名原样请求，让调用方拿到真实错误）
    let realPath = pathname;
    let queryString = Object.keys(params).length ? new URLSearchParams(params).toString() : '';
    try {
      const s = await this.wbi.signPath(pathname, params);
      if (s.signed) { realPath = s.pathname; queryString = s.query; }
    } catch (e) { console.error('[bili-api] WBI 签名失败，退回未签名请求:', e.message); }
    const url = 'https://api.bilibili.com' + realPath + (queryString ? '?' + queryString : '');
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Cookie: this.cookie }, signal: AbortSignal.timeout(20000) });
      // 平台级风控：熔断
      if (r.status === 412 || r.status === 429) { const m = this.trip('HTTP ' + r.status); const c = this.cacheGet(key); if (c) return { code: 0, data: c, fromCache: true }; return { code: -412, message: 'HTTP ' + r.status + ' 风控，熔断 ' + m + ' 分钟' }; }
      if (!r.ok) return { code: -1, message: 'HTTP ' + r.status };
      const body = await r.json().catch(() => null);
      if (!body) return { code: -1, message: '非 JSON 响应' };
      // 接口层风控码（HTTP 200 但 code=-412 等）
      if (BAN_CODES.has(body.code)) { const m = this.trip('code ' + body.code); const c = this.cacheGet(key); if (c) return { code: 0, data: c, fromCache: true }; return { code: body.code, message: 'B站风控码 ' + body.code + '，熔断 ' + m + ' 分钟' }; }
      if (body.code !== 0) return { code: body.code, message: body.message || '接口失败' };
      // 成功：清零熔断 + 写缓存
      this.clearBan();
      if (opts.cache !== false) this.cacheSet(key, body.data);
      return { code: 0, data: body.data };
    } catch (e) {
      const c = this.cacheGet(key);
      if (c) return { code: 0, data: c, fromCache: true };
      return { code: -1, message: e.name === 'TimeoutError' ? '请求超时' : '网络异常：' + e.message };
    }
  }

  saveCredential() { writeJson(this.credFile, { cookie: this.cookie, savedAt: Date.now() }); }
  logout() { this.cookie = ''; try { fs.unlinkSync(this.credFile); } catch {} return { ok: true }; }
}

module.exports = { BiliApi };

"use strict";
// WBI 签名（移植自 dsh-bili-whale 的 tools/lib/bili-api.mjs signWbi）
//
// 原理：B站部分接口（wbi/view、wbi/playurl 等）要求参数带 w_rid/wts，
// 密钥从 nav 接口的 wbi_img.img_url/sub_url 文件名拼出来，按 MIXIN 表
// 重排取前 32 位。密钥会轮换，nav 结果只缓存 10 分钟。
//
// 零依赖：只用 node:crypto 的 md5。
const crypto = require('crypto');

// 社区逆向的重排表（whale 与 Bilibili-API-Collect 一致）
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

// wbi 密钥会轮换，nav 结果只缓存 10 分钟
const NAV_TTL_MS = 10 * 60 * 1000;

// 从 img_url/sub_url 文件名取密钥本体（去扩展名）
function keyOf(url) {
  const s = String(url || '');
  return s.slice(s.lastIndexOf('/') + 1, s.lastIndexOf('.'));
}

// 由 wbi_img 两张图 URL 算出 32 位混入密钥；缺图返回 null
function mixinKey(wbiImg) {
  const raw = keyOf(wbiImg && wbiImg.img_url) + keyOf(wbiImg && wbiImg.sub_url);
  if (raw.length !== 64) return null;
  return MIXIN_KEY_ENC_TAB.map(i => raw[i]).join('').slice(0, 32);
}

// 签名：params -> 完整 query 字符串（含 wts 与 w_rid）。
// params: 业务参数（不含 wts/w_rid）；wbiImg: nav.data.wbi_img；
// now: 毫秒时间戳（测试可注入）。密钥缺失时抛错。
function signWbi(params, wbiImg, now = Date.now()) {
  const key = mixinKey(wbiImg);
  if (!key) throw new Error('WBI 签名密钥缺失：nav 未返回 wbi_img 或 URL 不完整');
  const values = { ...params, wts: Math.floor(now / 1000) };
  delete values.w_rid;
  const query = Object.keys(values).sort()
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(String(values[k]).replace(/[!'()*]/g, '')))
    .join('&');
  return query + '&w_rid=' + crypto.createHash('md5').update(query + key).digest('hex');
}

// WBI 需要签名的路径改写表（whale 的 signedPaths）
const SIGNED_PATHS = {
  '/x/web-interface/view': '/x/web-interface/wbi/view',
  '/x/player/playurl': '/x/player/wbi/playurl',
};

// 带密钥缓存（10 分钟）的签名器。getKey 应返回 nav 响应的 wbi_img。
function createWbiSigner(getKey) {
  let cachedKey = null;
  let cachedAt = 0;
  let inflight = null;

  async function getFreshKey() {
    if (inflight) return inflight;
    inflight = (async () => {
      const img = await getKey();
      if (!img || !mixinKey(img)) throw new Error('WBI 签名密钥不可用：nav 未返回有效 wbi_img');
      cachedKey = img; cachedAt = Date.now();
      return img;
    })();
    try { return await inflight; } finally { inflight = null; }
  }

  return {
    mixinKey,
    // 密钥是否仍新鲜（10 分钟内）
    hasFreshKey() { return !!(cachedKey && Date.now() - cachedAt < NAV_TTL_MS); },
    // 判断 pathname 是否需要签名并给出改写结果：
    // 返回 { signed, pathname, query }
    async signPath(pathname, params) {
      if (!SIGNED_PATHS[pathname]) return { signed: false, pathname, query: new URLSearchParams(params).toString() };
      let img;
      if (this.hasFreshKey()) img = cachedKey;
      else img = await getFreshKey();
      return { signed: true, pathname: SIGNED_PATHS[pathname], query: signWbi(params, img) };
    },
    // 测试用：清缓存
    reset() { cachedKey = null; cachedAt = 0; },
  };
}

module.exports = { MIXIN_KEY_ENC_TAB, keyOf, mixinKey, signWbi, SIGNED_PATHS, createWbiSigner, NAV_TTL_MS };

"use strict";
// capture/watch 测试：node --test test/capture.test.cjs
//
// 网络相关的 playurl 只 mock（不打真 B站）；ffmpeg 检测跑真实检测（本机装没装都以真实结果断言）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const capture = require('../lib/capture.cjs');
const wbi = require('../lib/wbi.cjs');

// ── wbi.cjs：纯函数，用社区公开测试向量 ────────────────────────────────
test('wbi: mixinKey 与官方文档向量一致', () => {
  const wbiImg = {
    img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
    sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
  };
  assert.strictEqual(wbi.mixinKey(wbiImg), 'ea1db124af3c7062474693fa704f4ff8');
});

test('wbi: signWbi 产出官方示例的 w_rid', () => {
  const wbiImg = {
    img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
    sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
  };
  const q = wbi.signWbi({ foo: 'one one', bar: 'two two', zab: 'three', wts: 1702204800 }, wbiImg, 1702204800000);
  assert.match(q, /bar=two%20two&foo=one%20one&wts=1702204800&zab=three&w_rid=716afe728e21b0273e7902f7118d5354/);
});

test('wbi: 密钥缺失时 signWbi 抛错且 mixinKey 返回 null', () => {
  assert.strictEqual(wbi.mixinKey({ img_url: '', sub_url: '' }), null);
  assert.throws(() => wbi.signWbi({}, { img_url: '', sub_url: '' }), /密钥缺失/);
});

test('wbi: signer 缓存 nav 密钥（10 分钟内只取一次）', async () => {
  let calls = 0;
  const signer = wbi.createWbiSigner(async () => {
    calls++;
    return {
      img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
      sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
    };
  });
  const a = await signer.signPath('/x/player/playurl', { bvid: 'BV1xx411c79H', qn: 16 });
  const b = await signer.signPath('/x/player/playurl', { bvid: 'BV1xx411c79H', qn: 16 });
  assert.strictEqual(calls, 1, '第二次应命中缓存');
  assert.strictEqual(a.pathname, '/x/player/wbi/playurl');
  assert.match(a.query, /w_rid=[0-9a-f]{32}/);
  assert.match(a.query, /wts=\d+/);
  assert.ok(!a.query.includes('w_rid=w_rid'));
  // 无关路径不签名
  const c = await signer.signPath('/x/v2/reply/main', { oid: 1 });
  assert.strictEqual(c.signed, false);
  assert.strictEqual(c.query, 'oid=1');
  // 无关路径也消耗不了缓存
  assert.strictEqual(calls, 1);
  signer.reset();
});

// ── bili-api.cjs：WBI 自动签名（mock fetch，不打网络）──────────────────
test('bili-api: /x/player/playurl 自动加 w_rid/wts 并改写路径', async () => {
  const seen = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    seen.push(String(url));
    const u = new URL(url);
    if (u.pathname === '/x/web-interface/nav') {
      return makeJson({ code: 0, message: '0', data: { wbi_img: {
        img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
        sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
      } } });
    }
    return makeJson({ code: 0, message: '0', data: { echo: u.searchParams.get('w_rid') } });
  };
  try {
    const { BiliApi } = require('../lib/bili-api.cjs');
    const api = new BiliApi();
    api.cookie = 'buvid3=test'; // 跳过 buvid 网络刷新
    const r = await api.request('/x/player/playurl', { bvid: 'BV1xx411c79H', cid: 1, qn: 16 });
    assert.strictEqual(r.code, 0);
    const playCall = seen.find(u => u.includes('/x/player/'));
    assert.ok(playCall, '应发起 playurl 请求');
    assert.ok(playCall.includes('/x/player/wbi/playurl'), '路径应改写为 wbi 版本: ' + playCall);
    assert.match(playCall, /w_rid=[0-9a-f]{32}/);
    assert.match(playCall, /wts=\d+/);
    assert.match(playCall, /bvid=BV1xx411c79H/);
    // 签名失败（nav 没给密钥）时优雅退回未签名请求
  } finally { global.fetch = realFetch; }
});

test('bili-api: nav 没给 wbi_img 时退回未签名请求不抛异常', async () => {
  const seen = [];
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    seen.push(String(url));
    const u = new URL(url);
    if (u.pathname === '/x/web-interface/nav') return makeJson({ code: -101, message: '账号未登录', data: {} });
    return makeJson({ code: 0, message: '0', data: { ok: true } });
  };
  try {
    const { BiliApi } = require('../lib/bili-api.cjs');
    const api = new BiliApi();
    api.cookie = 'buvid3=test';
    const r = await api.request('/x/player/playurl', { bvid: 'BV1xx411c79H', cid: 1 });
    assert.strictEqual(r.code, 0, '应退回未签名且正常返回');
    assert.ok(seen.some(u => u.includes('/x/player/playurl?')), '未签名原路径应被请求: ' + seen.join(' | '));
  } finally { global.fetch = realFetch; }
});

function makeJson(obj) {
  return { ok: true, status: 200, headers: new Map(), json: async () => obj };
}

// ── capture.cjs：ffmpeg 检测（真实检测，本机装没装都断言优雅）──────────
test('capture: detectFfmpeg 返回稳定结构', () => {
  const r = capture.detectFfmpeg();
  assert.ok(typeof r.ok === 'boolean');
  if (r.ok) { assert.ok(r.path, '有 ffmpeg 应给路径'); }
  else { assert.strictEqual(r.reason, 'no-ffmpeg'); }
});

test('capture: extractFrames 在无 ffmpeg 时优雅降级不抛', () => {
  const ff = capture.detectFfmpeg();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-test-'));
  try {
    const r = capture.extractFrames('https://example.invalid/v.mp4', tmp, 120, { grid: '3x3' });
    if (!ff.ok) {
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.reason, 'no-ffmpeg');
    } else {
      // 本机有 ffmpeg：直链无效应失败但不抛
      assert.strictEqual(r.ok, false);
      assert.ok(r.error);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('capture: downloadSegment 在无 ffmpeg 时优雅降级', async () => {
  const ff = capture.detectFfmpeg();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-test-'));
  const out = path.join(tmp, 'seg.mp4');
  try {
    const r = await capture.downloadSegment('https://example.invalid/v.mp4', out, 5);
    if (!ff.ok) {
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.reason, 'no-ffmpeg');
    } else {
      assert.strictEqual(r.ok, false, '无效直链应失败不抛');
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ── watch.cjs：mock capture 模块方法，验证一条龙的编排 ────────────────
test('watch: ffmpeg 不可用时返回 no-ffmpeg + fallback', async () => {
  const real = { detect: capture.detectFfmpeg };
  capture.detectFfmpeg = () => ({ ok: false, reason: 'no-ffmpeg' });
  try {
    const { watchVideo } = require('../commands/watch.cjs');
    const r = await watchVideo({}, { bvid: 'BV1xx411c79H' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'no-ffmpeg');
    assert.strictEqual(r.fallback, '只有字幕和简介可用');
  } finally { capture.detectFfmpeg = real; }
});

test('watch: 正常路径返回九宫格绝对路径（mock playurl+抽帧）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-test-'));
  const fakeSheet = path.join(tmp, 'sheet.jpg');
  fs.writeFileSync(fakeSheet, 'fake');
  const real = { detect: capture.detectFfmpeg, play: capture.getPlayUrl, frames: capture.extractFrames };
  capture.detectFfmpeg = () => ({ ok: true, path: 'ffmpeg' });
  capture.getPlayUrl = async () => ({ ok: true, url: 'https://cdn/v.m4s', backup: [], quality: 16, cid: 9, duration: 600 });
  capture.extractFrames = (_u, outDir, dur, opts) => {
    assert.strictEqual(opts.grid, '3x3');
    return { ok: true, sheet: fakeSheet, grid: '3x3', times: [1, 2, 3], tile: 720 };
  };
  try {
    const { watchVideo } = require('../commands/watch.cjs');
    const r = await watchVideo({}, { bvid: 'BV1xx411c79H' });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.frames, [fakeSheet]);
    assert.ok(path.isAbsolute(r.sheet), '应给绝对路径');
    assert.match(r.note, /九宫格/);
  } finally {
    capture.detectFfmpeg = real.detect; capture.getPlayUrl = real.play; capture.extractFrames = real.frames;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('watch: bvid 格式不对直接拒绝', async () => {
  const { watchVideo } = require('../commands/watch.cjs');
  const r = await watchVideo({}, { bvid: 'not-a-bv' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /bvid/);
});

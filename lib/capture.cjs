"use strict";
// ffmpeg 抽帧 + 九宫格（照 dsh-bili-whale 的 tools/commands/bili-watch.mjs 思路）
//
// 一条龙：bvid -> WBI 签名 playurl（qn=16 低清晰度省流量）-> ffmpeg 从直链抽帧
//        -> tile 滤镜拼 3x3 九宫格 JPEG。
//
// 设计要点：
//   - ffmpeg 只是外部二进制（PATH 里找），没有就全程优雅降级 { ok:false, reason:'no-ffmpeg' }
//   - 下载前 N 秒 / 抽帧都直接让 ffmpeg 读 https 直链（带 Referer 头），B站直链支持 Range
//   - 零 npm 依赖：只用 node 内置模块
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureDir, stateFile } = require('./paths.cjs');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
// ffmpeg 给远程直链的请求头（B站直链必须带 Referer，否则 403）
const FFMPEG_HEADERS = 'Referer: https://www.bilibili.com/\r\nUser-Agent: ' + UA + '\r\n';
// ffmpeg 单次进程超时（按时长放大由调用方传）
const BASE_TIMEOUT_MS = 120000;

let cachedFfmpeg = null;   // 检测结果缓存（null=未检测, false=没有）
let cachedAt = 0;
const DETECT_TTL = 5 * 60 * 1000;

/**
 * ffmpeg 可用性检测：先 where ffmpeg，再 ffmpeg -version 实跑一次。
 * @returns {{ ok: boolean, path?: string, reason?: 'no-ffmpeg' }}
 */
function detectFfmpeg() {
  if (cachedFfmpeg !== null && Date.now() - cachedAt < DETECT_TTL) {
    return cachedFfmpeg ? { ok: true, path: cachedFfmpeg } : { ok: false, reason: 'no-ffmpeg' };
  }
  cachedAt = Date.now();
  // ① where ffmpeg（Windows）
  let ffPath = 'ffmpeg';
  try {
    const out = execFileSync('where', ['ffmpeg'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    const first = String(out).split(/\r?\n/).map(s => s.trim()).find(Boolean);
    if (first) ffPath = first;
  } catch { /* where 没找到，继续用 PATH 裸名试 */ }
  // ② ffmpeg -version 真能跑
  try {
    const r = spawnSync(ffPath, ['-version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    if (r.error || r.status !== 0) { cachedFfmpeg = false; return { ok: false, reason: 'no-ffmpeg' }; }
    cachedFfmpeg = ffPath;
    return { ok: true, path: ffPath };
  } catch {
    cachedFfmpeg = false;
    return { ok: false, reason: 'no-ffmpeg' };
  }
}

// 不可用时的统一降级返回
function noFfmpeg(extra) {
  return { ok: false, reason: 'no-ffmpeg', ...(extra ? { message: String(extra) } : {}) };
}

/**
 * 拿视频直链：WBI 签名 playurl，选低清晰度（qn=16）省流量。
 * @param {import('./bili-api.cjs').BiliApi} api
 * @param {string} bvid
 * @param {object} [opts] { cid, qn=16 }
 * @returns {Promise<{ok:true,url:string,quality:number,cid:number,duration:number,backup:string[]} | {ok:false,error:string,code?:number}>}
 */
async function getPlayUrl(api, bvid, opts = {}) {
  const qn = Number(opts.qn) || 16;
  // ① 元信息：拿 cid / duration（多分P取第一P，对齐 whale）
  const view = await api.request('/x/web-interface/view', { bvid });
  if (view.code !== 0) return { ok: false, error: view.message || '取视频信息失败', code: view.code };
  const v = view.data;
  const cid = Number(opts.cid) || Number(v.pages && v.pages[0] && v.pages[0].cid) || Number(v.cid);
  const duration = Number(v.pages && v.pages[0] && v.pages[0].duration) || Number(v.duration) || 0;
  if (!cid) return { ok: false, error: '没拿到 cid' };
  // ② playurl：platform=html5 + qn=16 → 走 durl（普通 mp4 直链），ffmpeg 才能直接读
  //    （whale 实测：platform=pc + dash 拿到的是分轨流，ffmpeg 不好直接啃；html5 给整段 mp4）
  const p = await api.request('/x/player/playurl', {
    bvid, cid, qn, fnval: 1, platform: 'html5', high_quality: 0,
  });
  if (p.code !== 0) return { ok: false, error: p.message || 'playurl 失败', code: p.code };
  const durl = (p.data && p.data.durl && p.data.durl[0]) || null;
  const url = durl && (durl.url || (durl.durl && durl.durl[0]));
  if (!url) return { ok: false, error: '没拿到直链（可能需要登录或该清晰度只有 dash）' };
  return {
    ok: true,
    url: String(url),
    backup: ((durl && durl.backup_url) || []).filter(Boolean).map(String),
    quality: Number(p.data && p.data.quality) || qn,
    cid, duration,
  };
}

/**
 * 下载视频前 N 秒到本地（ffmpeg 直接从直链截取，-t 限时长）。
 * @returns {Promise<{ok:true,file:string,bytes:number} | {ok:false,reason?:string,error:string}>}
 */
async function downloadSegment(url, outPath, seconds) {
  if (!url) return { ok: false, error: '没有直链' };
  const sec = Math.max(1, Math.min(600, Number(seconds) || 60));
  ensureDir(path.dirname(outPath));
  const ff = detectFfmpeg();
  if (!ff.ok) return noFfmpeg();
  const timeout = BASE_TIMEOUT_MS + sec * 4000; // 每秒视频给 4s 余量
  const args = [
    '-y', '-loglevel', 'error',
    '-headers', FFMPEG_HEADERS,
    '-i', url,
    '-t', String(sec),
    '-c', 'copy', '-an',
    '-movflags', '+faststart',
    outPath,
  ];
  const r = spawnSync(ff.path, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  if (r.error || r.status !== 0 || !fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
    const stderr = String((r.stderr && r.stderr.toString()) || r.error && r.error.message || '').slice(0, 300);
    return { ok: false, error: 'ffmpeg 截取失败：' + (stderr || 'status ' + r.status) };
  }
  return { ok: true, file: outPath, bytes: fs.statSync(outPath).size };
}

/**
 * 抽帧拼九宫格：按时间桶均匀取 N 帧 → 每帧缩放到 tile 宽 → tile 拼一张 JPEG。
 * ffmpeg 直接从 https 直链读（不先下载整段），qn=16 时前面几十秒就够覆盖。
 * @param {string} videoPathOrUrl 本地文件或 https 直链
 * @param {string} outDir 输出目录
 * @param {number} duration 视频总秒数
 * @param {object} [opts] { grid='3x3', tile=720, ss=0 截取起点秒 }
 * @returns {{ ok:true, sheet:string, frames:string[], grid:string, times:number[] } | { ok:false, reason?:string, error:string }}
 */
function extractFrames(videoPathOrUrl, outDir, duration, opts = {}) {
  const ff = detectFfmpeg();
  if (!ff.ok) return noFfmpeg();
  const grid = String(opts.grid || '3x3');
  const [cols, rows] = grid.split('x').map(Number);
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols * rows > 64) {
    return { ok: false, error: 'grid 格式应为 3x3 这种' };
  }
  const tile = Math.max(160, Math.min(1280, Number(opts.tile) || 720));
  const dur = Number(duration) > 0 ? Number(duration) : 0;
  const ss = Math.max(0, Number(opts.ss) || 0);
  const N = cols * rows;
  ensureDir(outDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const sheet = path.join(outDir, 'sheet-' + stamp + '-' + grid + '.jpg');
  // 时间桶：把 [ss, ss+dur] 均分成 N 段取中点（避开头尾黑屏）
  const span = dur > 0 ? dur : 60;
  const times = Array.from({ length: N }, (_, i) => ss + ((i + 0.5) * span) / N);

  const tmp = path.join(outDir, '.frames-' + stamp);
  ensureDir(tmp);
  try {
    // ① 每个时间点抽一帧（-ss 放 -i 前是关键帧快照，够用且快）
    const timeout = BASE_TIMEOUT_MS + Math.round(span * 1500);
    for (let i = 0; i < N; i++) {
      const frame = path.join(tmp, 'f' + String(i).padStart(2, '0') + '.jpg');
      const r = spawnSync(ff.path, [
        '-y', '-loglevel', 'error',
        '-headers', FFMPEG_HEADERS,
        '-ss', times[i].toFixed(2),
        '-i', videoPathOrUrl,
        '-frames:v', '1', '-q:v', '2',
        frame,
      ], { timeout: Math.min(60000, timeout / Math.max(1, N)), windowsHide: true, maxBuffer: 1024 * 1024 });
      if (r.error || r.status !== 0 || !fs.existsSync(frame) || fs.statSync(frame).size === 0) {
        // 单帧失败不致命：继续抽下一帧，最后 tile 前补黑帧
        console.error('[capture] 第 ' + (i + 1) + ' 帧抽帧失败，跳过');
      }
    }
    // ② 缺的帧补齐（用已有第一帧复制），tile 需要正好 N 张
    const got = fs.readdirSync(tmp).filter(f => /^f\d+\.jpg$/.test(f)).sort();
    if (!got.length) return { ok: false, error: '所有帧都抽帧失败（直链可能已过期或网络不通）' };
    for (let i = 0; i < N; i++) {
      const want = path.join(tmp, 'f' + String(i).padStart(2, '0') + '.jpg');
      if (!fs.existsSync(want)) fs.copyFileSync(path.join(tmp, got[0]), want);
    }
    // ③ tile 拼图（每格缩放到 tile 宽）
    const r2 = spawnSync(ff.path, [
      '-y', '-loglevel', 'error',
      '-i', path.join(tmp, 'f%02d.jpg'),
      '-vf', 'scale=' + tile + ':-1,format=yuvj420p,tile=' + cols + 'x' + rows,
      '-frames:v', '1', '-q:v', '3',
      sheet,
    ], { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    if (r2.error || r2.status !== 0 || !fs.existsSync(sheet)) {
      const stderr = String((r2.stderr && r2.stderr.toString()) || r2.error && r2.error.message || '').slice(0, 300);
      return { ok: false, error: '拼图失败：' + (stderr || 'status ' + r2.status) };
    }
    return { ok: true, sheet, grid, times, tile };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { detectFfmpeg, getPlayUrl, downloadSegment, extractFrames, noFfmpeg };

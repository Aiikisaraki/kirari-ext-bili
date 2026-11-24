"use strict";
// notes：有来源的可审计记忆的命令入口（照 dsh-bili-whale「每条记忆带来源事件
// 与可核对的引用」的设计）。纯包装，无业务逻辑；真实逻辑都在 lib/memory-store.cjs。
//
//   add(args)    记一条见闻  { bvid, title, excerpt, takeaway, kind?, knownPersons? }
//   recall(args) 按关键词召回  { keywords: '词1 词2' 或 ['词1','词2'], now? }
//   stats(now)   按 lifecycle 统计（current/recent/stable/expired）
//
// 隐私红线不变：add 内部逐字段过 isSafeBiliMemory，命中即整条拒绝。
const store = require('../lib/memory-store.cjs');

/** 记一条带来源的见闻。@returns {{ok:boolean, note?:object, reason?:string, overflowed?:number}} */
function add(args = {}, opts = {}) {
  const now = opts.now;
  const injected = Number.isFinite(Number(now)) ? { now: Number(now), knownPersons: opts.knownPersons } : { knownPersons: opts.knownPersons };
  const r = store.add({
    bvid: args?.bvid, title: args?.title, excerpt: args?.excerpt,
    takeaway: args?.takeaway, kind: args?.kind,
  }, injected);
  return r;
}

/** 按关键词召回（命中则 recalled++，驱动 lifecycle 流转） */
function recall(args = {}, opts = {}) {
  const kw = args?.keywords;
  const now = Number(opts.now);
  const hits = Number.isFinite(now) ? store.recall(kw, now) : store.recall(kw);
  return { ok: true, keywords: Array.isArray(kw) ? kw : store.splitKeywords(kw), hits };
}

/** 按 lifecycle 统计。@returns {{total,current,recent,stable,expired}} */
function stats(opts = {}) {
  const now = Number(opts.now);
  return Number.isFinite(now) ? store.stats(now) : store.stats();
}

module.exports = { add, recall, stats };

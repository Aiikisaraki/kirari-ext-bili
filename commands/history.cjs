"use strict";
// 已看/已评记录（去重 + 可审计来源）
const fs = require('fs');
const { stateFile } = require('../lib/paths.cjs');
const FILE = () => stateFile('history.json');
function load() { try { return JSON.parse(fs.readFileSync(FILE(), 'utf-8')); } catch { return { seen: [], notes: [] }; } }
function save(v) { try { fs.writeFileSync(FILE(), JSON.stringify(v, null, 2), { mode: 0o600 }); } catch {} }
function seenBvids() { return load().seen.map(x => x.bvid); }
function markSeen(list) {
  const v = load(); const now = Date.now();
  for (const bvid of list) { if (!v.seen.some(x => x.bvid === bvid)) v.seen.push({ bvid, at: now }); }
  if (v.seen.length > 500) v.seen = v.seen.slice(-500);
  save(v);
}
/** 记录一条带来源的发现（bvid + 她读到的片段），可审计 */
function addNote({ bvid, title, excerpt, takeaway }) {
  const v = load();
  v.notes.push({ bvid: String(bvid||''), title: String(title||'').slice(0,120), excerpt: String(excerpt||'').slice(0,300), takeaway: String(takeaway||'').slice(0,200), at: Date.now() });
  if (v.notes.length > 200) v.notes = v.notes.slice(-200);
  save(v);
}
function recentNotes(n = 10) { return load().notes.slice(-n); }
module.exports = { seenBvids, markSeen, addNote, recentNotes };
